import { build, version, license, homepage, bugs } from "../../package.json";

export const app_info = {
  name: build.productName,
  version,
  license,
};

export const app_links = {
  project: homepage,
  issues: bugs.url,
  license: `${homepage}/blob/HEAD/LICENSE.txt`,
  notices: `${homepage}/blob/HEAD/THIRD_PARTY_NOTICES.md`,
} as const;

export type AppLink = keyof typeof app_links;
