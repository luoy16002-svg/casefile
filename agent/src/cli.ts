import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { errorMessage } from "./evidence/http.js";

export function isMain(url: string): boolean {
  return !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === url;
}
export async function cli(main: () => Promise<void>): Promise<void> {
  try { await main(); }
  catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
}
