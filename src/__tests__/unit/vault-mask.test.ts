/**
 * Unit tests for vault credential masking.
 *
 * Invariant we're pinning: "LLMs never see plaintext through tools."
 * The API also masks, but defence in depth — the MCP layer redacts
 * sensitive nested fields one more time before surfacing the response
 * to the LLM. If the upstream server ever drifts (regression, version
 * skew, malformed cache hit), this layer still catches it.
 *
 * Tests are intentionally specific about which fields stay, which get
 * "****" replacement, and which get dropped entirely (refreshToken).
 */
import { describe, expect, test } from "bun:test";
import { maskCredentialFields } from "../../tools/vault/index.js";

describe("maskCredentialFields", () => {
	test("masks login.password and login.totp; preserves username and uris", () => {
		const out = maskCredentialFields({
			id: "cr_1",
			name: "GitHub",
			login: {
				username: "diyan",
				password: "hunter2-very-secret",
				totp: "JBSWY3DPEHPK3PXP",
				uris: [{ uri: "https://github.com", match: "host" }],
			},
		});
		const login = out.login as Record<string, unknown>;
		expect(login.password).toBe("****");
		expect(login.totp).toBe("****");
		// Non-secret fields survive unchanged.
		expect(login.username).toBe("diyan");
		expect(login.uris).toEqual([{ uri: "https://github.com", match: "host" }]);
	});

	test("login with no password does not get a phantom mask key", () => {
		// Regression guard: a credential that doesn't HAVE a password
		// should not gain `password: "****"` in the response — that would
		// imply a secret exists when it doesn't.
		const out = maskCredentialFields({
			id: "cr_2",
			name: "Just a note",
			login: { username: "diyan" },
		});
		const login = out.login as Record<string, unknown>;
		expect(login.username).toBe("diyan");
		expect("password" in login).toBe(false);
		expect("totp" in login).toBe(false);
	});

	test("masks card.code (CVV) and partially masks card.number to last 4", () => {
		const out = maskCredentialFields({
			id: "cr_3",
			name: "Amex",
			card: {
				cardholderName: "DIYAN BOGDANOV",
				brand: "amex",
				number: "378282246310005",
				expMonth: "12",
				expYear: "2028",
				code: "1234",
			},
		});
		const card = out.card as Record<string, unknown>;
		expect(card.code).toBe("****");
		expect(card.number).toBe("****0005");
		// Cardholder name + brand + expiration are non-secrets, must survive.
		expect(card.cardholderName).toBe("DIYAN BOGDANOV");
		expect(card.brand).toBe("amex");
		expect(card.expMonth).toBe("12");
		expect(card.expYear).toBe("2028");
	});

	test("card with non-string number is left alone (defensive: no crash)", () => {
		// API contract says number is a string, but if a malformed row
		// ever returned a number-as-number, we should not throw — just
		// not attempt the slice(-4) mask. Code (CVV) still masks.
		const out = maskCredentialFields({
			id: "cr_4",
			card: { number: 12345 as unknown as string, code: "999" },
		});
		const card = out.card as Record<string, unknown>;
		expect(card.code).toBe("****");
		// Number untouched because the slice path only fires for strings.
		expect(card.number).toBe(12345);
	});

	test("masks oauth.accessToken and oauth.idToken; DROPS refreshToken entirely", () => {
		// refreshToken is the highest-value secret (it mints fresh access
		// tokens). Masking it with "****" still leaks "a refresh token
		// exists for this credential" — drop the key entirely instead.
		const out = maskCredentialFields({
			id: "cr_5",
			oauth: {
				accessToken: "ya29.a0AfH6SMB...",
				refreshToken: "1//0eABCDEFGHIJ...",
				idToken: "eyJhbGciOiJSUzI1Ni...",
				scope: "openid email",
				expiresAt: "2026-05-21T12:00:00Z",
			},
		});
		const oauth = out.oauth as Record<string, unknown>;
		expect(oauth.accessToken).toBe("****");
		expect(oauth.idToken).toBe("****");
		expect("refreshToken" in oauth).toBe(false);
		// Non-secret metadata survives.
		expect(oauth.scope).toBe("openid email");
		expect(oauth.expiresAt).toBe("2026-05-21T12:00:00Z");
	});

	test("masks identity.ssn, .passportNumber, .licenseNumber; preserves address", () => {
		const out = maskCredentialFields({
			id: "cr_6",
			identity: {
				firstName: "Diyan",
				lastName: "Bogdanov",
				email: "diyan@example.com",
				ssn: "123-45-6789",
				passportNumber: "X12345678",
				licenseNumber: "DL-987654",
				address1: "1 Main St",
				city: "Sofia",
			},
		});
		const identity = out.identity as Record<string, unknown>;
		expect(identity.ssn).toBe("****");
		expect(identity.passportNumber).toBe("****");
		expect(identity.licenseNumber).toBe("****");
		// Non-PII-secret fields stay.
		expect(identity.firstName).toBe("Diyan");
		expect(identity.email).toBe("diyan@example.com");
		expect(identity.address1).toBe("1 Main St");
		expect(identity.city).toBe("Sofia");
	});

	test("top-level fields outside the four secret blocks are untouched", () => {
		// Anything not in {login, card, oauth, identity} passes through —
		// id, name, type, fields, favorite, timestamps, etc. The mask
		// should never silently drop a top-level field.
		const out = maskCredentialFields({
			id: "cr_7",
			name: "My Credential",
			type: "login",
			favorite: true,
			notes: "personal notes",
			fields: [{ name: "custom", value: "value" }],
			createdAt: "2026-05-01T00:00:00Z",
		});
		expect(out.id).toBe("cr_7");
		expect(out.name).toBe("My Credential");
		expect(out.type).toBe("login");
		expect(out.favorite).toBe(true);
		expect(out.notes).toBe("personal notes");
		expect(out.fields).toEqual([{ name: "custom", value: "value" }]);
		expect(out.createdAt).toBe("2026-05-01T00:00:00Z");
	});

	test("returns a NEW object (does not mutate input)", () => {
		// The mask must be non-mutating — the caller may still hold the
		// raw credential object (e.g. in update flows where the request
		// body had plaintext) and we should not surprise-modify it.
		const input = {
			id: "cr_8",
			login: { username: "x", password: "secret" },
		};
		const out = maskCredentialFields(input);
		expect(out).not.toBe(input);
		expect(out.login).not.toBe(input.login);
		// Original still has plaintext.
		expect(input.login.password).toBe("secret");
		// Output is masked.
		expect((out.login as { password: string }).password).toBe("****");
	});

	test("an empty input object returns an empty object (no key invented)", () => {
		const out = maskCredentialFields({});
		expect(out).toEqual({});
	});
});
