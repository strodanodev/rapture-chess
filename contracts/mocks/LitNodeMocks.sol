// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Test doubles for the four LitNode contracts LitNodeWager reads.
contract MockNodeStake {
    mapping(bytes32 => bool) public active;
    mapping(bytes32 => address) public operators;
    function set(bytes32 nodeKey, bool on) external { active[nodeKey] = on; }
    function setOperator(bytes32 nodeKey, address operator) external { operators[nodeKey] = operator; }
    function standingOf(bytes32 nodeKey) external view returns (address operator, uint256 amount, bool isActive) {
        address op = operators[nodeKey];
        return (op == address(0) ? address(0xBEEF) : op, active[nodeKey] ? 1e18 : 0, active[nodeKey]);
    }
}

contract MockTitleRegistry {
    mapping(uint256 => address) public owners;
    function set(string calldata rulesetId, address owner) external { owners[uint256(keccak256(bytes(rulesetId)))] = owner; }
    function ownerOf(uint256 titleId) external view returns (address) {
        address o = owners[titleId];
        require(o != address(0), "no title");
        return o;
    }
}

contract MockMatchBook {
    struct Entry { uint8 status; bytes32 resultHash; }
    mapping(bytes32 => Entry) public entries;
    function set(bytes32 matchId, uint8 status, bytes32 resultHash) external { entries[matchId] = Entry(status, resultHash); }
    function statusOf(bytes32 matchId) external view returns (uint8 status, bytes32 resultHash, uint8 attests, uint8 agreeing) {
        Entry memory e = entries[matchId];
        return (e.status, e.resultHash, 3, 3);
    }
}

contract MockPlayerProfile {
    struct Owner { address owner; bool active; }
    mapping(bytes32 => Owner) public owners;
    function set(bytes32 key, address owner, bool active) external { owners[key] = Owner(owner, active); }
    function ownerOfKey(bytes32 key) external view returns (address owner, uint256 tokenId, bool active) {
        Owner memory o = owners[key];
        return (o.owner, o.active ? 1 : 0, o.active);
    }
}

/// A recipient that refuses zkLTC, so a payout is held in `pending`.
contract PayoutRefuser {
    receive() external payable { revert("no"); }
    function call(address to, bytes calldata data) external payable returns (bytes memory) {
        (bool ok, bytes memory out) = to.call{value: msg.value}(data);
        require(ok, "call");
        return out;
    }
}
