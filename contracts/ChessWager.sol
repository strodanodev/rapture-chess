// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title ChessWager
 * @notice Escrow for a two-player Rapture Chess wager in the chain's native token (zkLTC on LitVM Liteforge).
 *
 * The creator opens a match with a stake and the joiner matches it. The match is then played off chain over the
 * relay, which records a Deckwright-style log `{ seed, entries: [{ k, inputs: [side0, side1] }] }`. When the game
 * ends, the `resolver` signs an EIP-712 `Settlement(matchId, winner, logHash)` and either party submits it here.
 *
 * Ids and hashes (mirrored in src/web3/wager.ts):
 *   matchId    = keccak256(seed)                        seed: 32 random bytes the creator picks and reveals to the relay
 *   seedCommit = keccak256("rapture-chess/seed/v1", seed)  a domain-tagged commitment, emitted for off-chain verifiers
 *   logHash    = keccak256(abi.encode(bytes32 seed, int32[] inputs))  inputs flattened: e0.side0, e0.side1, e1.side0, ...
 *
 * Resolver swap path: today the resolver is the relay operator's key. When LitNode settles Rapture Chess matches, the
 * owner points `resolver` at the LitNode settlement signer (or a contract that re-signs after MatchBook.settle), with
 * no change to this escrow or to the clients: the typed data is the same.
 *
 * Funds never get stuck: an open match can be cancelled by its creator, and a live match without a settlement after
 * `settleTimeout` can be split 50/50 by either player. Payouts are pushed with a bounded gas stipend and, if the
 * recipient refuses them, held in `pending` for `withdraw()`.
 */
contract ChessWager is Ownable, ReentrancyGuard, EIP712 {
    enum Status { None, Open, Live, Settled, Cancelled, TimedOut }

    struct Match {
        address creator;      // side 0, Alliance
        address joiner;       // side 1, Horde
        uint96 stake;         // per player, in wei
        uint64 createdAt;
        uint64 joinedAt;
        Status status;
        uint8 winner;         // 0 creator, 1 joiner, 2 draw; valid once Settled
        bytes32 seedCommit;
        bytes32 logHash;      // valid once Settled
    }

    bytes32 public constant SETTLEMENT_TYPEHASH = keccak256("Settlement(bytes32 matchId,uint8 winner,bytes32 logHash)");
    uint16 public constant MAX_FEE_BPS = 500;

    address public resolver;
    address public feeRecipient;
    uint16 public feeBps;
    uint64 public settleTimeout;
    uint256 public accruedFees;

    mapping(bytes32 => Match) public matches;
    mapping(address => uint256) public pending;

    event MatchCreated(bytes32 indexed matchId, address indexed creator, uint256 stake, bytes32 seedCommit);
    event MatchJoined(bytes32 indexed matchId, address indexed joiner);
    event MatchSettled(bytes32 indexed matchId, uint8 winner, bytes32 logHash, uint256 payout, uint256 fee);
    event MatchCancelled(bytes32 indexed matchId);
    event MatchTimedOut(bytes32 indexed matchId, address indexed by);
    event Paid(address indexed to, uint256 amount, bool held);
    event Withdrawn(address indexed to, uint256 amount);
    event ResolverSet(address indexed resolver);
    event FeeSet(uint16 feeBps, address indexed feeRecipient);
    event SettleTimeoutSet(uint64 settleTimeout);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error ZeroStake();
    error MatchExists();
    error WrongStatus(Status have, Status want);
    error WrongStake(uint256 have, uint256 want);
    error NotAParty();
    error SelfPlay();
    error BadWinner();
    error BadSignature();
    error TooEarly(uint64 readyAt);
    error FeeTooHigh();
    error NothingToWithdraw();
    error TransferFailed();

    constructor(address initialOwner, address initialResolver, uint64 initialSettleTimeout)
        Ownable(initialOwner)
        EIP712("RaptureChessWager", "1")
    {
        resolver = initialResolver;
        feeRecipient = initialOwner;
        settleTimeout = initialSettleTimeout;
        emit ResolverSet(initialResolver);
        emit SettleTimeoutSet(initialSettleTimeout);
    }

    // ------------------------------------------------------------------ players

    /// @notice Open a match and escrow your stake (`msg.value`). `matchId` is keccak256(seed); reveal the seed to the relay only.
    function createMatch(bytes32 matchId, bytes32 seedCommit) external payable {
        if (msg.value == 0 || msg.value > type(uint96).max) revert ZeroStake();
        Match storage m = matches[matchId];
        if (m.status != Status.None) revert MatchExists();
        m.creator = msg.sender;
        m.stake = uint96(msg.value);
        m.createdAt = uint64(block.timestamp);
        m.status = Status.Open;
        m.seedCommit = seedCommit;
        emit MatchCreated(matchId, msg.sender, msg.value, seedCommit);
    }

    /// @notice Take the Horde seat by matching the stake exactly.
    function joinMatch(bytes32 matchId) external payable {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert WrongStatus(m.status, Status.Open);
        if (msg.sender == m.creator) revert SelfPlay();
        if (msg.value != m.stake) revert WrongStake(msg.value, m.stake);
        m.joiner = msg.sender;
        m.joinedAt = uint64(block.timestamp);
        m.status = Status.Live;
        emit MatchJoined(matchId, msg.sender);
    }

    /// @notice Pay out a finished match with the resolver's EIP-712 signature. Anyone may submit it.
    function settle(bytes32 matchId, uint8 winner, bytes32 logHash, bytes calldata resolverSig) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Live) revert WrongStatus(m.status, Status.Live);
        if (winner > 2) revert BadWinner();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, matchId, winner, logHash)));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, resolverSig);
        if (err != ECDSA.RecoverError.NoError || signer == address(0) || signer != resolver) revert BadSignature();

        m.status = Status.Settled;
        m.winner = winner;
        m.logHash = logHash;
        uint256 stake = m.stake;
        uint256 pot = stake * 2;
        uint256 fee = 0;
        uint256 payout;
        if (winner == 2) {
            payout = stake;
            _pay(m.creator, stake);
            _pay(m.joiner, stake);
        } else {
            fee = (pot * feeBps) / 10_000;
            payout = pot - fee;
            accruedFees += fee;
            _pay(winner == 0 ? m.creator : m.joiner, payout);
        }
        emit MatchSettled(matchId, winner, logHash, payout, fee);
    }

    /// @notice Take back the stake of a match nobody joined.
    function cancel(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert WrongStatus(m.status, Status.Open);
        if (msg.sender != m.creator) revert NotAParty();
        m.status = Status.Cancelled;
        _pay(m.creator, m.stake);
        emit MatchCancelled(matchId);
    }

    /// @notice No settlement arrived in time: either player splits the pot 50/50 so nothing stays locked.
    function timeoutClaim(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Live) revert WrongStatus(m.status, Status.Live);
        if (msg.sender != m.creator && msg.sender != m.joiner) revert NotAParty();
        uint64 readyAt = m.joinedAt + settleTimeout;
        if (block.timestamp < readyAt) revert TooEarly(readyAt);
        m.status = Status.TimedOut;
        _pay(m.creator, m.stake);
        _pay(m.joiner, m.stake);
        emit MatchTimedOut(matchId, msg.sender);
    }

    /// @notice Collect a payout that could not be pushed to you.
    function withdraw() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pending[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ------------------------------------------------------------------ owner

    function setResolver(address newResolver) external onlyOwner {
        resolver = newResolver;
        emit ResolverSet(newResolver);
    }

    function setFee(uint16 newFeeBps, address newRecipient) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        feeRecipient = newRecipient;
        emit FeeSet(newFeeBps, newRecipient);
    }

    function setSettleTimeout(uint64 newTimeout) external onlyOwner {
        settleTimeout = newTimeout;
        emit SettleTimeoutSet(newTimeout);
    }

    function withdrawFees() external onlyOwner nonReentrant {
        uint256 amount = accruedFees;
        if (amount == 0) revert NothingToWithdraw();
        accruedFees = 0;
        (bool ok, ) = feeRecipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesWithdrawn(feeRecipient, amount);
    }

    // ------------------------------------------------------------------ views

    /// @notice The EIP-712 digest the resolver signs for a settlement (for off-chain checks).
    function settlementDigest(bytes32 matchId, uint8 winner, bytes32 logHash) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLEMENT_TYPEHASH, matchId, winner, logHash)));
    }

    // ------------------------------------------------------------------ internal

    /// @dev Push with a bounded stipend; a recipient that refuses keeps a claim in `pending`.
    function _pay(address to, uint256 amount) internal {
        (bool ok, ) = to.call{value: amount, gas: 30_000}("");
        if (!ok) pending[to] += amount;
        emit Paid(to, amount, !ok);
    }
}
