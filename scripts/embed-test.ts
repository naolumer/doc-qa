import "dotenv/config";
import { embedTexts } from "../lib/embed";

async function main() {
  const [vector] = await embedTexts(["Bitcoin is a peer-to-peer electronic cash system."]);
  console.log("dimensions:", vector.length);
  console.log("first 3 values:", vector.slice(0, 3));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});