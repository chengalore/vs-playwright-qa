import { readFileSync, writeFileSync } from "fs";

const NUM_CHUNKS = 5;

const stores = JSON.parse(readFileSync("data/monitor-urls.json", "utf8"));

// Round-robin distribution gives balanced chunks regardless of store count
const chunks = Array.from({ length: NUM_CHUNKS }, () => []);
stores.forEach((store, i) => chunks[i % NUM_CHUNKS].push(store));

writeFileSync("data/monitor-chunks.json", JSON.stringify(chunks, null, 2));

console.log(
  `Split ${stores.length} stores into ${NUM_CHUNKS} chunks (${chunks.map((c) => c.length).join(", ")} stores each)`
);
