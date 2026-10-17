import {
  build,
  version,
  license,
  homepage,
  bugs,
  repository,
} from "../../package.json";

export const app_info = {
  name: build.productName,
  version,
  license,
};

const repository_url = repository.url
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");

export const app_links = {
  project: homepage,
  issues: bugs.url,
  license: `${repository_url}/blob/HEAD/LICENSE.txt`,
  notices: `${repository_url}/blob/HEAD/THIRD_PARTY_NOTICES.md`,
} as const;

export type AppLink = keyof typeof app_links;
