// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IChessWager {
    function createMatch(bytes32 matchId, bytes32 seedCommit) external payable;
    function withdraw() external;
}

/// @dev Test helper: a player contract that refuses pushed payouts until told to accept them.
contract PayoutRefuser {
    IChessWager public immutable wager;
    bool public accept;

    constructor(address w) { wager = IChessWager(w); }

    function create(bytes32 matchId, bytes32 seedCommit) external payable { wager.createMatch{value: msg.value}(matchId, seedCommit); }
    function setAccept(bool v) external { accept = v; }
    function withdraw() external { wager.withdraw(); }

    receive() external payable { require(accept, "refused"); }
}
