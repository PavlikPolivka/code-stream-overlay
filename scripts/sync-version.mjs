// Runs from `npm version`: copy package.json's version into src/constants.ts.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const file = path.join(root, "src", "constants.ts");
const src = readFileSync(file, "utf8");
const next = src.replace(/export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`);
if (next === src && !src.includes(`VERSION = "${version}"`)) throw new Error("VERSION constant not found in src/constants.ts");
writeFileSync(file, next);
console.log(`VERSION = ${version}`);
