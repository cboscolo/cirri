const CHARSET = "234567abcdefghijklmnopqrstuvwxyz";

const tid = process.argv[2];
if (!tid) {
  console.error("Usage: bun decode-tid.ts <tid>");
  process.exit(1);
}

let num = 0n;
for (const c of tid) num = num * 32n + BigInt(CHARSET.indexOf(c));
const timestampUs = num >> 10n;
const date = new Date(Number(timestampUs / 1000n));

console.log(date.toLocaleString());
