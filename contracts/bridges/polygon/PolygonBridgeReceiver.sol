// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

// XXX import ITimelock interface

contract PolygonBridgeReceiver {
    address public mainnetTimelock;
    address public l2Timelock; // also the admin

    constructor(
        address _mainnetTimelock,
        address _l2Timelock
    ) {
        mainnetTimelock = _mainnetTimelock;
        l2Timelock = _l2Timelock;
    }

    function changeL2Timelock(address newTimelock) {
        if (msg.sender != l2Timelock) revert Unauthorized();
        l2Timelock = newTimelock;
    }

    function changeMainnetTimelock(address newTimelock) {
        if (msg.sender != l2Timelock) revert Unauthorized();
        mainnetTimelock = newTimelock;
    }

    function processMessageFromRoot(
        uint256 stateId,
        address messageSender, // original msg.sender that called fxRoot (l1 timelock)
        bytes calldata data
    ) external override onlyFxChild {
        if (messageSender != mainnetTimelock) revert UnauthorizedRootOrigin();

        address[] memory targets;
        uint256[] memory values;
        string[] memory signatures;
        bytes[] memory calldatas;

        (targets, values, signatures, calldatas) = abi.decode(
            data,
            (address[], uint256[], string[], bytes[])
        );

        // XXX calculate eta

        for (uint8 i = 0; i < targets.length; ) {
            ITimelock(l2Timelock).queueTransaction(targets[i], values[i], signatures[i], calldatas[i], eta);
            unchecked { i++; }
        }
    }
}