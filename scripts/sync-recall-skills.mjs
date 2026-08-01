import { copyFile, mkdir } from "node:fs/promises";

const source = new URL("../skills/wtm-recall/SKILL.md", import.meta.url);
const targets = [
  new URL("../.agents/skills/wtm-recall/SKILL.md", import.meta.url),
  new URL("../.claude/skills/wtm-recall/SKILL.md", import.meta.url),
];

for (const target of targets) {
  await mkdir(new URL(".", target), { recursive: true });
  await copyFile(source, target);
}

console.log("synced wtm-recall skill for Codex and Claude");
