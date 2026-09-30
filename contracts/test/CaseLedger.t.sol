// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CaseLedger} from "../src/CaseLedger.sol";

contract CaseLedgerTest is Test {
    CaseLedger ledger;
    address other = address(0xBEEF);
    bytes32 constant ASSET = bytes32("BTC");
    bytes32 constant REVIEW = keccak256("review");
    uint256 nonce;

    event CaseOpened(
        uint256 indexed id,
        address indexed agent,
        bytes32 indexed bundleHash,
        bytes32 asset,
        CaseLedger.Side side,
        uint16 sizeBps,
        uint64 entryE8,
        uint64 stopE8,
        uint64 targetE8,
        uint32 horizon
    );
    event CaseClosed(
        uint256 indexed id,
        address indexed agent,
        uint64 exitE8,
        int32 pnlBps,
        CaseLedger.CloseReason reason,
        bytes32 reviewHash
    );

    function setUp() public {
        ledger = new CaseLedger();
    }

    function open(CaseLedger.Side side, uint16 size, uint64 entry) internal returns (uint256) {
        uint64 stop = side == CaseLedger.Side.Flat ? 0 : side == CaseLedger.Side.Long ? entry / 2 : entry * 2;
        uint64 target = side == CaseLedger.Side.Flat ? 0 : side == CaseLedger.Side.Long ? entry * 2 : entry / 2;
        return ledger.openCase(keccak256(abi.encode(++nonce)), ASSET, side, size, entry, stop, target, 3600);
    }

    function openingHash(CaseLedger.Case memory c) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                c.agent,
                c.bundleHash,
                c.asset,
                c.side,
                c.sizeBps,
                c.entryE8,
                c.stopE8,
                c.targetE8,
                c.openedAt,
                c.horizon
            )
        );
    }

    function testOpenAllSidesEventsAndViews() public {
        bytes32 hash = keccak256(abi.encode(uint256(1)));
        vm.expectEmit(true, true, true, true);
        emit CaseOpened(1, address(this), hash, ASSET, CaseLedger.Side.Long, 2000, 100, 50, 200, 3600);
        assertEq(open(CaseLedger.Side.Long, 2000, 100), 1);
        assertEq(open(CaseLedger.Side.Short, 1, 100), 2);
        assertEq(open(CaseLedger.Side.Flat, 0, 100), 3);
        CaseLedger.Case memory c = ledger.getCase(1);
        assertEq(c.agent, address(this));
        assertEq(c.bundleHash, hash);
        assertEq(c.openedAt, block.timestamp);
        assertEq(c.closedAt, 0);
        assertTrue(ledger.isSealed(hash));
        assertEq(ledger.caseCount(), 3);
        (uint32 cases, uint32 opened, uint32 closed,,,) = ledger.stats(address(this));
        assertEq(cases, 3);
        assertEq(opened, 3);
        assertEq(closed, 0);
        uint256[] memory ids = ledger.casesOf(address(this), 1, type(uint256).max);
        assertEq(ids.length, 2);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);
        assertEq(ledger.casesOf(address(this), 0, 1).length, 1);
        assertEq(ledger.casesOf(address(this), 0, 0).length, 0);
        assertEq(ledger.casesOf(address(this), 3, 1).length, 0);
        assertEq(ledger.casesOf(other, type(uint256).max, type(uint256).max).length, 0);
        vm.prank(other);
        ledger.openCase(keccak256("other"), ASSET, CaseLedger.Side.Flat, 0, 100, 0, 0, 3600);
        assertEq(ledger.casesOf(other, 0, 10)[0], 4);
        assertEq(ledger.casesOf(address(this), 0, 10).length, 3);
    }

    function testInvalidOpenInputs() public {
        bytes32 hash = keccak256("a");
        vm.expectRevert(CaseLedger.InvalidBundleHash.selector);
        ledger.openCase(0, ASSET, CaseLedger.Side.Flat, 0, 100, 0, 0, 3600);
        vm.expectRevert(CaseLedger.InvalidAsset.selector);
        ledger.openCase(hash, 0, CaseLedger.Side.Flat, 0, 100, 0, 0, 3600);
        vm.expectRevert(CaseLedger.InvalidEntryPrice.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Flat, 0, 0, 0, 0, 3600);
        vm.expectRevert(CaseLedger.InvalidHorizon.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Flat, 0, 100, 0, 0, 3599);
        vm.expectRevert(CaseLedger.InvalidHorizon.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Flat, 0, 100, 0, 0, 30 days + 1);
        for (uint256 side; side < 3; ++side) {
            vm.expectRevert(CaseLedger.InvalidSize.selector);
            ledger.openCase(hash, ASSET, CaseLedger.Side(side), side == 0 ? 1 : 0, 100, 0, 0, 3600);
            if (side != 0) {
                vm.expectRevert(CaseLedger.InvalidSize.selector);
                ledger.openCase(hash, ASSET, CaseLedger.Side(side), 10001, 100, 0, 0, 3600);
            }
        }
        vm.expectRevert(CaseLedger.InvalidLevels.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Flat, 0, 100, 1, 0, 3600);
        vm.expectRevert(CaseLedger.InvalidLevels.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Flat, 0, 100, 0, 1, 3600);
        vm.expectRevert(CaseLedger.InvalidLevels.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Long, 1, 100, 100, 200, 3600);
        vm.expectRevert(CaseLedger.InvalidLevels.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Long, 1, 100, 50, 100, 3600);
        vm.expectRevert(CaseLedger.InvalidLevels.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Short, 1, 100, 100, 50, 3600);
        vm.expectRevert(CaseLedger.InvalidLevels.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Short, 1, 100, 200, 100, 3600);
    }

    function testHorizonBoundsAndMaximumSize() public {
        ledger.openCase(keccak256("min"), ASSET, CaseLedger.Side.Long, 10000, 100, 0, 200, 3600);
        ledger.openCase(keccak256("max"), ASSET, CaseLedger.Side.Short, 10000, 100, 200, 0, 30 days);
    }

    function testCaseExistenceUsesIdRatherThanAgentAddress() public {
        vm.prank(address(0));
        uint256 id = ledger.openCase(keccak256("zero-agent"), ASSET, CaseLedger.Side.Flat, 0, 100, 0, 0, 3600);
        assertEq(ledger.getCase(id).agent, address(0));
        vm.warp(block.timestamp + 3600);
        vm.prank(address(0));
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        assertEq(uint256(ledger.getCase(id).reason), uint256(CaseLedger.CloseReason.Horizon));
    }

    function testBundleCannotBeReusedEvenAfterCloseOrByAnotherAgent() public {
        uint256 id = open(CaseLedger.Side.Flat, 0, 100);
        bytes32 hash = ledger.getCase(id).bundleHash;
        vm.warp(block.timestamp + 3600);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        vm.prank(other);
        vm.expectRevert(CaseLedger.BundleAlreadySealed.selector);
        ledger.openCase(hash, ASSET, CaseLedger.Side.Flat, 0, 100, 0, 0, 3600);
        assertTrue(ledger.isSealed(hash));
    }

    function testInvalidCloseInputsAndUnknownCases() public {
        vm.expectRevert(CaseLedger.CaseNotFound.selector);
        ledger.getCase(0);
        vm.expectRevert(CaseLedger.CaseNotFound.selector);
        ledger.getCase(1);
        vm.expectRevert(CaseLedger.CaseNotFound.selector);
        ledger.closeCase(1, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        uint256 id = open(CaseLedger.Side.Long, 2000, 100);
        vm.prank(other);
        vm.expectRevert(CaseLedger.NotCaseAgent.selector);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        vm.expectRevert(CaseLedger.InvalidExitPrice.selector);
        ledger.closeCase(id, 0, CaseLedger.CloseReason.Stop, REVIEW);
        vm.expectRevert(CaseLedger.InvalidReviewHash.selector);
        ledger.closeCase(id, 50, CaseLedger.CloseReason.Stop, 0);
        vm.expectRevert(CaseLedger.InvalidCloseReason.selector);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.None, REVIEW);
        vm.expectRevert(CaseLedger.HorizonNotReached.selector);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        vm.warp(block.timestamp + 3599);
        vm.expectRevert(CaseLedger.HorizonNotReached.selector);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        vm.warp(block.timestamp + 1);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        vm.expectRevert(CaseLedger.CaseAlreadyClosed.selector);
        ledger.closeCase(id, 100, CaseLedger.CloseReason.Horizon, REVIEW);
    }

    function testFlatOnlyClosesAtHorizon() public {
        uint256 id = open(CaseLedger.Side.Flat, 0, 100);
        vm.expectRevert(CaseLedger.InvalidCloseReason.selector);
        ledger.closeCase(id, 50, CaseLedger.CloseReason.Stop, REVIEW);
        vm.expectRevert(CaseLedger.InvalidCloseReason.selector);
        ledger.closeCase(id, 200, CaseLedger.CloseReason.Target, REVIEW);
        vm.warp(block.timestamp + 3600);
        ledger.closeCase(id, 200, CaseLedger.CloseReason.Horizon, REVIEW);
        assertEq(ledger.getCase(id).pnlBps, 0);
    }

    function testStopsTargetsAndCloseEvent() public {
        uint256 ls = open(CaseLedger.Side.Long, 1000, 100);
        uint256 lt = open(CaseLedger.Side.Long, 1000, 100);
        uint256 ss = open(CaseLedger.Side.Short, 1000, 100);
        uint256 st = open(CaseLedger.Side.Short, 1000, 100);
        vm.expectRevert(CaseLedger.InconsistentExit.selector);
        ledger.closeCase(ls, 51, CaseLedger.CloseReason.Stop, REVIEW);
        vm.expectRevert(CaseLedger.InconsistentExit.selector);
        ledger.closeCase(lt, 199, CaseLedger.CloseReason.Target, REVIEW);
        vm.expectRevert(CaseLedger.InconsistentExit.selector);
        ledger.closeCase(ss, 199, CaseLedger.CloseReason.Stop, REVIEW);
        vm.expectRevert(CaseLedger.InconsistentExit.selector);
        ledger.closeCase(st, 51, CaseLedger.CloseReason.Target, REVIEW);
        vm.expectEmit(true, true, false, true);
        emit CaseClosed(ls, address(this), 50, -5000, CaseLedger.CloseReason.Stop, REVIEW);
        ledger.closeCase(ls, 50, CaseLedger.CloseReason.Stop, REVIEW);
        ledger.closeCase(lt, 200, CaseLedger.CloseReason.Target, REVIEW);
        ledger.closeCase(ss, 200, CaseLedger.CloseReason.Stop, REVIEW);
        ledger.closeCase(st, 50, CaseLedger.CloseReason.Target, REVIEW);
        assertEq(ledger.getCase(ls).pnlBps, -5000);
        assertEq(ledger.getCase(lt).pnlBps, 10000);
        assertEq(ledger.getCase(ss).pnlBps, -10000);
        assertEq(ledger.getCase(st).pnlBps, 5000);
        assertEq(ledger.getCase(st).reviewHash, REVIEW);
        assertEq(ledger.getCase(st).closedAt, block.timestamp);
    }

    function testExitBeyondStopAndTargetIsAccepted() public {
        ledger.closeCase(open(CaseLedger.Side.Long, 1, 100), 40, CaseLedger.CloseReason.Stop, REVIEW);
        ledger.closeCase(open(CaseLedger.Side.Long, 1, 100), 210, CaseLedger.CloseReason.Target, REVIEW);
        ledger.closeCase(open(CaseLedger.Side.Short, 1, 100), 210, CaseLedger.CloseReason.Stop, REVIEW);
        ledger.closeCase(open(CaseLedger.Side.Short, 1, 100), 40, CaseLedger.CloseReason.Target, REVIEW);
    }

    function testRoundingSmallAndLargePricesTowardZero() public {
        uint256 a = open(CaseLedger.Side.Long, 3333, 3);
        uint256 b = open(CaseLedger.Side.Short, 3333, 3);
        uint256 c = open(CaseLedger.Side.Long, 10000, 10000000000000);
        uint256 d = open(CaseLedger.Side.Long, 10000, 10000000000000);
        vm.warp(block.timestamp + 3600);
        ledger.closeCase(a, 2, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(b, 2, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(c, 10000000000001, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(d, 10001234567890, CaseLedger.CloseReason.Horizon, REVIEW);
        assertEq(ledger.getCase(a).pnlBps, -3333);
        assertEq(ledger.getCase(b).pnlBps, 3333);
        assertEq(ledger.getCase(c).pnlBps, 0);
        assertEq(ledger.getCase(d).pnlBps, 1);
    }

    function testStatsMixedWinsLossesFlatsAndBreakeven() public {
        uint256 a = open(CaseLedger.Side.Long, 2000, 100);
        uint256 b = open(CaseLedger.Side.Short, 3333, 100);
        uint256 c = open(CaseLedger.Side.Flat, 0, 100);
        uint256 d = open(CaseLedger.Side.Long, 100, 100);
        open(CaseLedger.Side.Short, 100, 100);
        vm.warp(block.timestamp + 3600);
        ledger.closeCase(a, 110, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(b, 103, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(c, 999, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(d, 100, CaseLedger.CloseReason.Horizon, REVIEW);
        (uint32 cases, uint32 opened, uint32 closed, uint32 wins, uint32 losses, int64 sized) =
            ledger.stats(address(this));
        assertEq(cases, 5);
        assertEq(opened, 1);
        assertEq(closed, 4);
        assertEq(wins, 1);
        assertEq(losses, 1);
        assertEq(sized, 101);
    }

    function testPnlOutsideInt32RevertsWithoutChangingCase() public {
        uint256 a = open(CaseLedger.Side.Long, 1, 2);
        uint256 b = open(CaseLedger.Side.Short, 1, 2);
        vm.expectRevert(CaseLedger.PnlOutOfRange.selector);
        ledger.closeCase(a, type(uint64).max, CaseLedger.CloseReason.Target, REVIEW);
        vm.expectRevert(CaseLedger.PnlOutOfRange.selector);
        ledger.closeCase(b, type(uint64).max, CaseLedger.CloseReason.Stop, REVIEW);
        assertEq(uint256(ledger.getCase(a).reason), 0);
    }

    function testTimestampOverflowOnOpenAndClose() public {
        uint256 id = open(CaseLedger.Side.Long, 1, 100);
        vm.warp(uint256(type(uint64).max) + 1);
        vm.expectRevert(CaseLedger.TimestampOutOfRange.selector);
        open(CaseLedger.Side.Flat, 0, 100);
        vm.expectRevert(CaseLedger.TimestampOutOfRange.selector);
        ledger.closeCase(id, 200, CaseLedger.CloseReason.Target, REVIEW);
    }

    function testStatsOverflowGuards() public {
        // Stats occupy one packed slot: five uint32 counters then int64 P&L.
        bytes32 slot = keccak256(abi.encode(address(this), uint256(2)));
        vm.store(address(ledger), slot, bytes32(uint256(type(uint32).max)));
        vm.expectRevert(CaseLedger.StatsOverflow.selector);
        open(CaseLedger.Side.Flat, 0, 100);
        vm.store(address(ledger), slot, 0);
        uint256 id = open(CaseLedger.Side.Long, 10000, 100);
        vm.store(
            address(ledger), slot, bytes32(uint256(1) | uint256(1) << 32 | uint256(uint64(type(int64).max)) << 160)
        );
        vm.expectRevert(CaseLedger.StatsOverflow.selector);
        ledger.closeCase(id, 200, CaseLedger.CloseReason.Target, REVIEW);
        vm.store(
            address(ledger), slot, bytes32(uint256(1) | uint256(1) << 32 | uint256(uint64(type(int64).min)) << 160)
        );
        vm.expectRevert(CaseLedger.StatsOverflow.selector);
        ledger.closeCase(id, 50, CaseLedger.CloseReason.Stop, REVIEW);
    }

    function testFuzzMirroredLongShortPnl(uint64 rawEntry, uint64 rawExit) public {
        uint64 entry = uint64(bound(rawEntry, 2, 1e14));
        uint64 exit = uint64(bound(rawExit, entry / 2, uint256(entry) * 2));
        uint256 a = open(CaseLedger.Side.Long, 2000, entry);
        uint256 b = open(CaseLedger.Side.Short, 2000, entry);
        vm.warp(block.timestamp + 3600);
        ledger.closeCase(a, exit, CaseLedger.CloseReason.Horizon, REVIEW);
        ledger.closeCase(b, exit, CaseLedger.CloseReason.Horizon, REVIEW);
        assertEq(int256(ledger.getCase(a).pnlBps), -int256(ledger.getCase(b).pnlBps));
    }

    function testFuzzOpeningFieldsImmutable(bytes memory sequence) public {
        uint256 id = open(CaseLedger.Side.Long, 2000, 100);
        CaseLedger.Case memory beforeCase = ledger.getCase(id);
        bytes32 beforeHash = openingHash(beforeCase);
        uint256 steps = sequence.length > 32 ? 32 : sequence.length;
        for (uint256 i; i < steps; ++i) {
            uint8 action = uint8(sequence[i]) % 5;
            if (action == 0) {
                vm.warp(block.timestamp + 3600);
                attempt(abi.encodeCall(ledger.closeCase, (id, uint64(110), CaseLedger.CloseReason.Horizon, REVIEW)));
            } else if (action == 1) {
                attempt(
                    abi.encodeCall(
                        ledger.openCase,
                        (
                            beforeCase.bundleHash,
                            ASSET,
                            CaseLedger.Side.Flat,
                            uint16(0),
                            uint64(100),
                            uint64(0),
                            uint64(0),
                            uint32(3600)
                        )
                    )
                );
            } else if (action == 2) {
                vm.prank(other);
                attempt(abi.encodeCall(ledger.closeCase, (id, uint64(50), CaseLedger.CloseReason.Stop, REVIEW)));
            } else if (action == 3) {
                open(CaseLedger.Side.Flat, 0, 100);
            } else {
                attempt(abi.encodeCall(ledger.closeCase, (id, uint64(200), CaseLedger.CloseReason.Target, REVIEW)));
            }
            assertEq(openingHash(ledger.getCase(id)), beforeHash);
            assertTrue(ledger.isSealed(beforeCase.bundleHash));
        }
    }

    function attempt(bytes memory data) internal {
        // Both accepted and rejected actions are part of the immutability sequence.
        (bool accepted,) = address(ledger).call(data);
        if (!accepted) assertTrue(data.length > 0);
    }
}
