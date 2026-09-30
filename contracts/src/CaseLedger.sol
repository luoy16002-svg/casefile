// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract CaseLedger {
    enum Side {
        Flat,
        Long,
        Short
    }
    enum CloseReason {
        None,
        Horizon,
        Stop,
        Target
    }

    struct Case {
        address agent;
        bytes32 bundleHash;
        bytes32 asset;
        Side side;
        uint16 sizeBps;
        uint64 entryE8;
        uint64 stopE8;
        uint64 targetE8;
        uint64 openedAt;
        uint32 horizon;
        uint64 closedAt;
        uint64 exitE8;
        int32 pnlBps;
        CloseReason reason;
        bytes32 reviewHash;
    }

    struct AgentStats {
        uint32 cases;
        uint32 open;
        uint32 closed;
        uint32 wins;
        uint32 losses;
        int64 sizedPnlBps;
    }

    error InvalidBundleHash();
    error BundleAlreadySealed();
    error InvalidAsset();
    error InvalidEntryPrice();
    error InvalidHorizon();
    error InvalidSize();
    error InvalidLevels();
    error CaseNotFound();
    error NotCaseAgent();
    error CaseAlreadyClosed();
    error InvalidExitPrice();
    error InvalidReviewHash();
    error InvalidCloseReason();
    error HorizonNotReached();
    error InconsistentExit();
    error PnlOutOfRange();
    error StatsOverflow();
    error TimestampOutOfRange();

    event CaseOpened(
        uint256 indexed id,
        address indexed agent,
        bytes32 indexed bundleHash,
        bytes32 asset,
        Side side,
        uint16 sizeBps,
        uint64 entryE8,
        uint64 stopE8,
        uint64 targetE8,
        uint32 horizon
    );
    event CaseClosed(
        uint256 indexed id, address indexed agent, uint64 exitE8, int32 pnlBps, CloseReason reason, bytes32 reviewHash
    );

    uint256 public caseCount;
    mapping(uint256 => Case) private _cases;
    mapping(address => AgentStats) public stats;
    mapping(address => uint256[]) private _agentCases;
    mapping(bytes32 => bool) public isSealed;

    function openCase(
        bytes32 bundleHash,
        bytes32 asset,
        Side side,
        uint16 sizeBps,
        uint64 entryE8,
        uint64 stopE8,
        uint64 targetE8,
        uint32 horizon
    ) external returns (uint256 id) {
        if (bundleHash == bytes32(0)) revert InvalidBundleHash();
        if (isSealed[bundleHash]) revert BundleAlreadySealed();
        if (asset == bytes32(0)) revert InvalidAsset();
        if (entryE8 == 0) revert InvalidEntryPrice();
        if (horizon < 1 hours || horizon > 30 days) revert InvalidHorizon();
        if (side == Side.Flat) {
            if (sizeBps != 0) revert InvalidSize();
            if (stopE8 != 0 || targetE8 != 0) revert InvalidLevels();
        } else {
            if (sizeBps == 0 || sizeBps > 10000) revert InvalidSize();
            if (side == Side.Long && !(stopE8 < entryE8 && entryE8 < targetE8)) revert InvalidLevels();
            if (side == Side.Short && !(targetE8 < entryE8 && entryE8 < stopE8)) revert InvalidLevels();
        }
        if (block.timestamp > type(uint64).max) revert TimestampOutOfRange();
        AgentStats storage s = stats[msg.sender];
        if (s.cases == type(uint32).max) revert StatsOverflow();
        id = ++caseCount;
        _cases[id] = Case({
            agent: msg.sender,
            bundleHash: bundleHash,
            asset: asset,
            side: side,
            sizeBps: sizeBps,
            entryE8: entryE8,
            stopE8: stopE8,
            targetE8: targetE8,
            openedAt: uint64(block.timestamp),
            horizon: horizon,
            closedAt: 0,
            exitE8: 0,
            pnlBps: 0,
            reason: CloseReason.None,
            reviewHash: bytes32(0)
        });
        isSealed[bundleHash] = true;
        _agentCases[msg.sender].push(id);
        ++s.cases;
        ++s.open;
        emit CaseOpened(id, msg.sender, bundleHash, asset, side, sizeBps, entryE8, stopE8, targetE8, horizon);
    }

    function closeCase(uint256 id, uint64 exitE8, CloseReason reason, bytes32 reviewHash) external {
        Case storage c = _existing(id);
        if (c.agent != msg.sender) revert NotCaseAgent();
        if (c.reason != CloseReason.None) revert CaseAlreadyClosed();
        if (exitE8 == 0) revert InvalidExitPrice();
        if (reviewHash == bytes32(0)) revert InvalidReviewHash();
        if (reason == CloseReason.Horizon) {
            if (block.timestamp < uint256(c.openedAt) + c.horizon) revert HorizonNotReached();
        } else if (reason == CloseReason.Stop || reason == CloseReason.Target) {
            if (c.side == Side.Flat) revert InvalidCloseReason();
            bool consistent = c.side == Side.Long
                ? (reason == CloseReason.Stop ? exitE8 <= c.stopE8 : exitE8 >= c.targetE8)
                : (reason == CloseReason.Stop ? exitE8 >= c.stopE8 : exitE8 <= c.targetE8);
            if (!consistent) revert InconsistentExit();
        } else {
            revert InvalidCloseReason();
        }
        if (block.timestamp > type(uint64).max) revert TimestampOutOfRange();
        int256 pnl = c.side == Side.Flat
            ? int256(0)
            : (int256(uint256(exitE8)) - int256(uint256(c.entryE8))) * 10000 / int256(uint256(c.entryE8));
        if (c.side == Side.Short) pnl = -pnl;
        if (pnl < type(int32).min || pnl > type(int32).max) revert PnlOutOfRange();
        AgentStats storage s = stats[c.agent];
        int256 sized = int256(s.sizedPnlBps) + pnl * int256(uint256(c.sizeBps)) / 10000;
        if (sized < type(int64).min || sized > type(int64).max) revert StatsOverflow();
        c.closedAt = uint64(block.timestamp);
        c.exitE8 = exitE8;
        c.pnlBps = int32(pnl);
        c.reason = reason;
        c.reviewHash = reviewHash;
        --s.open;
        ++s.closed;
        if (pnl > 0) ++s.wins;
        if (pnl < 0) ++s.losses;
        s.sizedPnlBps = int64(sized);
        emit CaseClosed(id, c.agent, exitE8, int32(pnl), reason, reviewHash);
    }

    function getCase(uint256 id) external view returns (Case memory) {
        return _existing(id);
    }

    function casesOf(address agent, uint256 offset, uint256 limit) external view returns (uint256[] memory ids) {
        uint256[] storage all = _agentCases[agent];
        if (offset >= all.length) return new uint256[](0);
        uint256 count = all.length - offset;
        if (limit < count) count = limit;
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = all[offset + i];
        }
    }

    function _existing(uint256 id) private view returns (Case storage c) {
        if (id == 0 || id > caseCount) revert CaseNotFound();
        c = _cases[id];
    }
}
