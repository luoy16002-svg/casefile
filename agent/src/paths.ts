import { realpath, mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const AGENT_DIR = resolve(ROOT, "agent");
const inside = (path: string) => {
  const rel = relative(ROOT, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

export async function workspacePath(path: string): Promise<string> {
  const absolute = resolve(path);
  if (!inside(absolute)) throw new Error("Path must stay inside the casefile folder");
  let parent = absolute;
  while (true) {
    try {
      if (!inside(await realpath(parent))) throw new Error("Path resolves outside the casefile folder");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parent = dirname(parent);
    }
  }
  return absolute;
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(await workspacePath(path), "utf8")) as unknown;
}

export async function writeImmutable(path: string, bytes: string): Promise<void> {
  const safe = await workspacePath(path);
  await mkdir(dirname(safe), { recursive: true });
  try { await writeFile(safe, bytes, { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(safe, "utf8") !== bytes) throw new Error(`Refusing to overwrite ${safe}`);
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const safe = await workspacePath(path);
  await mkdir(dirname(safe), { recursive: true });
  const temporary = `${safe}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, safe);
}

export async function exists(path: string): Promise<boolean> {
  try { await access(await workspacePath(path)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
