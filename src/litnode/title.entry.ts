// The LitNode title artifact's entry: `node <litnode>/tools/bundle-title.mjs src/litnode/title.entry.ts --out rulesets`
// inlines chess.js and the rules into rulesets/rapture-chess.v1.js and runs the conformance suite on the result.
import { defineChessTitle } from './chessTitle';

export default defineChessTitle();
