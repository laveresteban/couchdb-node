import { Configuration } from "../couchdb_client/src";

export const URL = process.env.COUCHDB_URL ?? "http://localhost:5984";
export const USER = process.env.COUCHDB_USER ?? "admin";
export const PASSWORD = process.env.COUCHDB_PASSWORD ?? "password";

export function uniqueName(prefix = "test"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${URL}/_up`)).ok;
  } catch {
    return false;
  }
}

export function makeConfig(): Configuration {
  return new Configuration({ basePath: URL, username: USER, password: PASSWORD });
}
