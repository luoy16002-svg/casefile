import { vi } from "vitest";

vi.stubGlobal("fetch", () => { throw new Error("Tests are offline; pass a mocked fetch"); });
