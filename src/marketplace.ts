import marketplace from "../marketplace.json";

export type MarketplaceMetadata = {
	name: string;
	description: string;
	version: string;
	author: string;
	tools: number;
	domains: string[];
	transport: string[];
	install: string;
};

export const marketplaceMetadata = marketplace as MarketplaceMetadata;
