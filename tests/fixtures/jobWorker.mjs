import { writeFileSync } from "node:fs";

const mode = process.argv[2] ?? "success";
const outIndex = process.argv.indexOf("--out");
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

if (outPath) {
  writeFileSync(
    outPath,
    JSON.stringify([{ username: "fixture", mode }]),
    "utf-8",
  );
}

console.log(`READY ${mode}`);

if (mode === "fail") {
  process.exitCode = 7;
} else if (mode === "hold" || mode === "hold-ignore") {
  if (mode === "hold-ignore") {
    process.on("SIGTERM", () => {
      console.log("IGNORED SIGTERM");
    });
  }
  setInterval(() => undefined, 1_000);
}
