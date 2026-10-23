// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ed25519} from "./vendor/Ed25519.sol";

/// Reads LitNode's NodeStake (contracts/NodeStake.sol): a bonded host node.
interface INodeStake {
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool active);
}

/// Reads LitNode's MatchBook (contracts/MatchBook.sol): the chain's word on a placed ranked match.
interface IMatchBook {
    /// Status: 0 None, 1 Committed, 2 Settled, 3 Final, 4 Void, 5 Escalating, 6 Escalated.
    function statusOf(bytes32 matchId) external view returns (uint8 status, bytes32 resultHash, uint8 attests, uint8 agreeing);
}

/// Reads LitNode's PlayerProfile (contracts/PlayerProfile.sol): which wallet a player key belongs to.
interface IPlayerProfile {
    function ownerOfKey(bytes32 key) external view returns (address owner, uint256 tokenId, bool active);
}

/// @title LitNodeWager: zkLTC stakes on Rapture Chess, paid out on LitNode's own match result.
///
/// No resolver key. A player binds a stake to their LitNode player key (the ed25519 key the arcade signs with).
/// When the mesh settles a Rapture Chess match between two staked players, the host node signs the settled DELTA
/// (`sign('delta', body)`, node/settle.js). Anyone submits that delta's canonical JSON and the host's signature:
/// the contract verifies the ed25519 signature on chain (vendor/Ed25519.sol), requires the host to be a bonded
/// LitNode (NodeStake.standingOf), requires both players to have signed the ledger (`attestation: "players"`),
/// and, when MatchBook knows the match (a placed ranked match), requires it to be FINAL with the same resultHash.
/// The pot is twice the smaller stake; the winner takes it, a draw returns it, the larger staker keeps the rest.
///
/// A loser cannot run: an unstake takes `unstakeDelay` seconds, set longer than MatchBook.totalWindow() so a
/// settled match can always be claimed before the stakes move.
contract LitNodeWager is Ownable, ReentrancyGuard {
    struct Stake {
        bytes32 key;        // the player key this wallet plays under
        uint256 amount;     // wei at stake
        uint64 unstakeAt;   // 0, or when unstake() may run
    }

    INodeStake public immutable nodeStake;
    IMatchBook public immutable matchBook;
    IPlayerProfile public immutable profile;   // address(0): no profile check
    uint64 public unstakeDelay;
    uint16 public feeBps;                      // of the pot, on a win only
    uint256 public fees;

    mapping(address => Stake) private stakes;
    mapping(bytes32 => address) public walletOf;   // player key → wallet
    mapping(bytes32 => bool) public claimed;       // matchId → paid
    mapping(address => uint256) public pending;    // payouts a recipient refused

    bytes private constant RULESET = bytes("rapture-chess.v1");
    uint8 private constant STATUS_NONE = 0;
    uint8 private constant STATUS_FINAL = 3;
    uint256 private constant SCALE = 1000; // scores as integers: 1 → 1000, 0.5 → 500

    event Staked(address indexed wallet, bytes32 indexed key, uint256 amount, uint256 total);
    event UnstakeRequested(address indexed wallet, uint64 at);
    event Unstaked(address indexed wallet, uint256 amount);
    event Claimed(bytes32 indexed matchId, bytes32 indexed hostKey, bytes32 keyA, bytes32 keyB, uint256 pot, address winner, uint256 fee);
    event PaymentHeld(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event FeeSet(uint16 bps);
    event UnstakeDelaySet(uint64 seconds_);

    error ZeroKey();
    error ZeroValue();
    error KeyTaken(bytes32 key, address wallet);
    error KeyBound(bytes32 current);
    error ProfileMismatch(bytes32 key, address owner);
    error NothingStaked();
    error NoRequest();
    error TooEarly(uint64 at);
    error AlreadyClaimed();
    error BadSignature();
    error HostNotBonded(bytes32 hostKey);
    error MatchMismatch();
    error NotFinal(uint8 status);
    error ResultMismatch();
    error NotPlayers();
    error NotReplayable();
    error NotComplete();
    error WrongRuleset();
    error NotStaked(bytes32 key);
    error Malformed(uint256 at);
    error FeeTooHigh();

    constructor(address owner_, INodeStake nodeStake_, IMatchBook matchBook_, IPlayerProfile profile_, uint64 unstakeDelay_) Ownable(owner_) {
        require(address(nodeStake_) != address(0) && address(matchBook_) != address(0), "litnode");
        nodeStake = nodeStake_;
        matchBook = matchBook_;
        profile = profile_;
        unstakeDelay = unstakeDelay_;
    }

    // ------------------------------------------------------------------ stakes

    /// Put zkLTC at stake under `key`, your LitNode player key. Repeating adds to the stake and cancels any unstake request.
    function stake(bytes32 key) external payable {
        if (key == bytes32(0)) revert ZeroKey();
        if (msg.value == 0) revert ZeroValue();
        Stake storage s = stakes[msg.sender];
        if (s.key != key) {
            if (s.amount != 0) revert KeyBound(s.key);          // rebinding only once the old stake is gone
            address holder = walletOf[key];
            if (holder != address(0) && holder != msg.sender) revert KeyTaken(key, holder);
            if (address(profile) != address(0)) {
                (address owner, , bool active) = profile.ownerOfKey(key);
                if (active && owner != msg.sender) revert ProfileMismatch(key, owner);
            }
            if (s.key != bytes32(0)) delete walletOf[s.key];
            s.key = key;
            walletOf[key] = msg.sender;
        }
        s.amount += msg.value;
        s.unstakeAt = 0;
        emit Staked(msg.sender, key, msg.value, s.amount);
    }

    function requestUnstake() external {
        Stake storage s = stakes[msg.sender];
        if (s.amount == 0) revert NothingStaked();
        s.unstakeAt = uint64(block.timestamp) + unstakeDelay;
        emit UnstakeRequested(msg.sender, s.unstakeAt);
    }

    function unstake() external nonReentrant {
        Stake storage s = stakes[msg.sender];
        if (s.amount == 0) revert NothingStaked();
        if (s.unstakeAt == 0) revert NoRequest();
        if (block.timestamp < s.unstakeAt) revert TooEarly(s.unstakeAt);
        uint256 amount = s.amount;
        s.amount = 0;
        s.unstakeAt = 0;
        emit Unstaked(msg.sender, amount);
        _pay(msg.sender, amount);
    }

    function stakeOf(address wallet) external view returns (uint256 amount, uint64 unstakeAt) {
        Stake storage s = stakes[wallet];
        return (s.amount, s.unstakeAt);
    }

    function keyOf(address wallet) external view returns (bytes32) { return stakes[wallet].key; }

    // ------------------------------------------------------------------ claims

    /// Pay out a settled LitNode match. `deltaJson` is the host node's delta body as canonical JSON (sorted keys,
    /// no whitespace, without hostSig/cosigners/cosigs/disputes); `hostSig` the 64-byte ed25519 signature the host
    /// made over `"delta" ‖ 0x00 ‖ deltaJson`.
    function claim(bytes32 matchId, bytes calldata deltaJson, bytes calldata hostSig) external nonReentrant {
        if (claimed[matchId]) revert AlreadyClaimed();
        Parsed memory p = _parse(deltaJson);
        if (p.matchId != matchId) revert MatchMismatch();
        if (!p.rulesetOk) revert WrongRuleset();
        if (!p.players) revert NotPlayers();
        if (!p.replayable) revert NotReplayable();
        if (!p.complete) revert NotComplete();
        if (!Ed25519.verify(p.hostKey, hostSig, abi.encodePacked("delta", bytes1(0), deltaJson))) revert BadSignature();
        _checkChain(matchId, p);
        claimed[matchId] = true;
        _payout(matchId, p);
    }

    /// The host must be a bonded LitNode; a match MatchBook knows must be FINAL on the same result.
    function _checkChain(bytes32 matchId, Parsed memory p) private view {
        (, , bool bonded) = nodeStake.standingOf(p.hostKey);
        if (!bonded) revert HostNotBonded(p.hostKey);
        (uint8 status, bytes32 onChain, , ) = matchBook.statusOf(matchId);
        if (status == STATUS_NONE) return;
        if (status != STATUS_FINAL) revert NotFinal(status);
        if (onChain != p.resultHash) revert ResultMismatch();
    }

    /// Twice the smaller stake is the pot; the winner takes it less the fee, a draw moves nothing.
    function _payout(bytes32 matchId, Parsed memory p) private {
        address a = walletOf[p.keyA];
        address b = walletOf[p.keyB];
        Stake storage sa = stakes[a];
        Stake storage sb = stakes[b];
        if (a == address(0) || sa.key != p.keyA || sa.amount == 0) revert NotStaked(p.keyA);
        if (b == address(0) || sb.key != p.keyB || sb.amount == 0) revert NotStaked(p.keyB);
        uint256 each = sa.amount < sb.amount ? sa.amount : sb.amount;
        if (p.scoreA == p.scoreB) {
            emit Claimed(matchId, p.hostKey, p.keyA, p.keyB, 2 * each, address(0), 0);
            return;
        }
        sa.amount -= each;
        sb.amount -= each;
        uint256 fee = (2 * each * feeBps) / 10_000;
        fees += fee;
        address winner = p.scoreA > p.scoreB ? a : b;
        emit Claimed(matchId, p.hostKey, p.keyA, p.keyB, 2 * each, winner, fee);
        _pay(winner, 2 * each - fee);
    }

    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingStaked();
        pending[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw");
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ owner

    function setFee(uint16 bps) external onlyOwner {
        if (bps > 500) revert FeeTooHigh();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setUnstakeDelay(uint64 seconds_) external onlyOwner {
        unstakeDelay = seconds_;
        emit UnstakeDelaySet(seconds_);
    }

    function withdrawFees(address to) external onlyOwner nonReentrant {
        uint256 amount = fees;
        fees = 0;
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "fees");
    }

    // ------------------------------------------------------------------ payouts

    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount, gas: 60_000}("");
        if (!ok) {
            pending[to] += amount;
            emit PaymentHeld(to, amount);
        }
    }

    // ------------------------------------------------------------------ the delta scanner
    //
    // LitNode's canonical JSON (protocol/canonical.js): object keys sorted, no whitespace, strings escaped only
    // as JSON.stringify does. Only depth-1 keys of the delta body are read; nested objects (hydrationManifest,
    // signatures, stats) are skipped by structure, so a nested key can never pose as a top-level one.

    struct Parsed {
        bytes32 hostKey;
        bytes32 matchId;
        bytes32 resultHash;
        bytes32 keyA;
        bytes32 keyB;
        uint256 scoreA;
        uint256 scoreB;
        bool rulesetOk;
        bool players;
        bool replayable;
        bool complete;
        uint8 seen; // bit flags of the required keys found
    }

    uint8 private constant F_HOST = 1;
    uint8 private constant F_MATCH = 2;
    uint8 private constant F_RESULT = 4;
    uint8 private constant F_PARTS = 8;
    uint8 private constant F_SCORES = 16;
    uint8 private constant F_ALL = 31;

    function _parse(bytes calldata j) internal pure returns (Parsed memory p) {
        uint256 n = j.length;
        if (n < 2 || j[0] != "{") revert Malformed(0);
        uint256 i = 1;
        while (true) {
            if (i >= n) revert Malformed(i);
            if (j[i] == "}") { if (i != n - 1) revert Malformed(i); break; }
            if (j[i] == ",") { i++; continue; }
            if (j[i] != '"') revert Malformed(i);
            (bytes32 key, uint256 keyLen, uint256 next) = _string(j, i);
            i = next;
            if (i >= n || j[i] != ":") revert Malformed(i);
            i++;
            uint256 vStart = i;
            i = _skipValue(j, i);
            _take(j, p, key, keyLen, vStart, i);
        }
        if (p.seen != F_ALL) revert Malformed(n);
    }

    /// Handle one top-level key whose value spans j[vStart:vEnd].
    function _take(bytes calldata j, Parsed memory p, bytes32 key, uint256 keyLen, uint256 vStart, uint256 vEnd) private pure {
        if (keyLen == 6 && key == bytes32("hostId")) { p.hostKey = _hex32(j, vStart, vEnd); p.seen |= F_HOST; }
        else if (keyLen == 7 && key == bytes32("matchId")) { p.matchId = _hex32(j, vStart, vEnd); p.seen |= F_MATCH; }
        else if (keyLen == 10 && key == bytes32("resultHash")) { p.resultHash = _hex32(j, vStart, vEnd); p.seen |= F_RESULT; }
        else if (keyLen == 9 && key == bytes32("rulesetId")) { p.rulesetOk = _isString(j, vStart, vEnd, RULESET); }
        else if (keyLen == 11 && key == bytes32("attestation")) { p.players = _isString(j, vStart, vEnd, bytes("players")); }
        else if (keyLen == 4 && key == bytes32("kind")) { p.replayable = _isString(j, vStart, vEnd, bytes("replayable")); }
        else if (keyLen == 8 && key == bytes32("complete")) { p.complete = vEnd - vStart == 4 && j[vStart] == "t" && j[vStart + 1] == "r" && j[vStart + 2] == "u" && j[vStart + 3] == "e"; }
        else if (keyLen == 12 && key == bytes32("participants")) {
            // ["<64hex>","<64hex>"]
            if (vEnd - vStart != 1 + 66 + 1 + 66 + 1 || j[vStart] != "[" || j[vStart + 67] != "," || j[vEnd - 1] != "]") revert Malformed(vStart);
            p.keyA = _hex32(j, vStart + 1, vStart + 67);
            p.keyB = _hex32(j, vStart + 68, vEnd - 1);
            if (p.keyA == p.keyB) revert Malformed(vStart);
            p.seen |= F_PARTS;
        }
        else if (keyLen == 6 && key == bytes32("scores")) {
            // {"<64hex>":<num>,"<64hex>":<num>} with the keys in sorted order, matched to the participants by value
            if (vEnd - vStart < 2 || j[vStart] != "{" || j[vEnd - 1] != "}") revert Malformed(vStart);
            uint256 i = vStart + 1;
            bool gotA; bool gotB;
            for (uint256 k = 0; k < 2; k++) {
                if (j[i] != '"') revert Malformed(i);
                bytes32 who = _hex32(j, i, i + 66);
                i += 66;
                if (j[i] != ":") revert Malformed(i);
                i++;
                uint256 e = _skipValue(j, i);
                uint256 v = _number(j, i, e);
                i = e;
                if (who == p.keyA && !gotA) { p.scoreA = v; gotA = true; }
                else if (who == p.keyB && !gotB) { p.scoreB = v; gotB = true; }
                else revert Malformed(i);
                if (k == 0) { if (j[i] != ",") revert Malformed(i); i++; }
            }
            if (i != vEnd - 1) revert Malformed(i);
            p.seen |= F_SCORES;
        }
    }

    /// A quoted string at j[i]: returns its first 32 bytes (for key comparison), its length and the index after the closing quote.
    function _string(bytes calldata j, uint256 i) private pure returns (bytes32 head, uint256 len, uint256 next) {
        uint256 n = j.length;
        uint256 start = i + 1;
        i = start;
        while (true) {
            if (i >= n) revert Malformed(i);
            bytes1 c = j[i];
            if (c == "\\") { i += 2; continue; }
            if (c == '"') break;
            i++;
        }
        len = i - start;
        if (len > 32) revert Malformed(start);
        for (uint256 k = 0; k < len; k++) head |= bytes32(j[start + k]) >> (8 * k);
        next = i + 1;
    }

    /// Skip one JSON value starting at j[i]; returns the index after it.
    function _skipValue(bytes calldata j, uint256 i) private pure returns (uint256) {
        uint256 n = j.length;
        if (i >= n) revert Malformed(i);
        bytes1 c = j[i];
        if (c == '"') {
            i++;
            while (true) {
                if (i >= n) revert Malformed(i);
                if (j[i] == "\\") { i += 2; continue; }
                if (j[i] == '"') return i + 1;
                i++;
            }
        }
        if (c == "{" || c == "[") {
            uint256 depth = 0;
            while (i < n) {
                bytes1 d = j[i];
                if (d == '"') { i = _skipValue(j, i); continue; }
                if (d == "{" || d == "[") depth++;
                else if (d == "}" || d == "]") { depth--; if (depth == 0) return i + 1; }
                i++;
            }
            revert Malformed(i);
        }
        // a literal or a number: runs until a separator
        while (i < n) {
            bytes1 d = j[i];
            if (d == "," || d == "}" || d == "]") return i;
            i++;
        }
        revert Malformed(i);
    }

    /// `"<64 lowercase hex>"` spanning j[s:e] → bytes32.
    function _hex32(bytes calldata j, uint256 s, uint256 e) private pure returns (bytes32 out) {
        if (e - s != 66 || j[s] != '"' || j[e - 1] != '"') revert Malformed(s);
        uint256 v;
        for (uint256 k = 1; k <= 64; k++) {
            uint8 c = uint8(j[s + k]);
            uint256 d;
            if (c >= 48 && c <= 57) d = c - 48;
            else if (c >= 97 && c <= 102) d = c - 87;
            else revert Malformed(s + k);
            v = (v << 4) | d;
        }
        out = bytes32(v);
    }

    /// Is j[s:e] exactly the quoted string `want`?
    function _isString(bytes calldata j, uint256 s, uint256 e, bytes memory want) private pure returns (bool) {
        if (e - s != want.length + 2 || j[s] != '"' || j[e - 1] != '"') return false;
        for (uint256 k = 0; k < want.length; k++) if (j[s + 1 + k] != want[k]) return false;
        return true;
    }

    /// A non-negative decimal with at most three fraction digits, scaled by 1000 (JSON.stringify never writes a plus sign or leading zeros).
    function _number(bytes calldata j, uint256 s, uint256 e) private pure returns (uint256 v) {
        if (e <= s || e - s > 12) revert Malformed(s);
        uint256 frac = 0;
        bool inFrac = false;
        for (uint256 i = s; i < e; i++) {
            uint8 c = uint8(j[i]);
            if (c == 46) { if (inFrac || i == s || i == e - 1) revert Malformed(i); inFrac = true; continue; }
            if (c < 48 || c > 57) revert Malformed(i);
            if (inFrac) { if (frac == 3) revert Malformed(i); frac++; }
            v = v * 10 + (c - 48);
        }
        for (; frac < 3; frac++) v *= 10;
        if (v > 1000 * SCALE) revert Malformed(s);
    }
}
