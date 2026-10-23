/** What the menu screens need from the game shell (main.ts): data, the wallet, and the few actions that touch the 3D stage. */
import type { ChainClient } from 'deckwright/web/lib/chain.js';
import type { Collection } from '../roster';
import type { Side } from '../rules/chessRules';
import type { RealmId } from '../scene/realm';
import type { Web3Link } from '../web3/wallet';
import type { Difficulty, RealmChoice } from './prefs';

export const ARCADE_URL = 'https://arcade.litvm.games/';
export const EXPLORER = 'https://liteforge.explorer.caldera.xyz';

export interface App {
  readonly snapshot: Collection;
  readonly web3: Web3Link;
  readonly chain: ChainClient;
  /** Start a practice game against the bot. */
  startSkirmish(side: Side, difficulty: Difficulty, realm: RealmChoice): void;
  /** Show a realm and banner colours behind the menus. */
  preview(realm: RealmId, side: Side): void;
  realmFor(choice: RealmChoice, side: Side): RealmId;
  /** The zkLTC stakes panel, in a dialog. */
  openStakes(): void;
  /** Ranked play happens in the LitVM arcade: explain and link. */
  openRanked(): void;
  setQuality(q: string): void;
  /** A LitNode node this page already knows (the host of a relayed match), for the ladder. */
  nodeHint(): string | null;
  /** The connected wallet's zkLTC balance (wei), or null. */
  balance(): Promise<bigint | null>;
  connect(): Promise<void>;
}
