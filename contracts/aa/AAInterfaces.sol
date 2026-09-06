// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*
 * Minimal ERC-4337 v0.7 interfaces — inlined in-house (no @account-abstraction, no third-party dependencies).
 * Canonical EntryPoint v0.7: 0x0000000071727De22E5E9d8BAf0edAc6f37da032 (all major chains).
 */

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;             // factory address ++ factory calldata (account creation)
    bytes callData;
    bytes32 accountGasLimits;   // verificationGasLimit (16) ++ callGasLimit (16)
    uint256 preVerificationGas;
    bytes32 gasFees;            // maxPriorityFeePerGas (16) ++ maxFeePerGas (16)
    bytes paymasterAndData;     // paymaster (20) ++ verifGas (16) ++ postOpGas (16) ++ data
    bytes signature;
}

interface IAccount {
    /// validationData: (sigFailed ? 1 : 0) | (validUntil << 160) | (validAfter << 208)
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

interface IPaymaster {
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
}

/// The EntryPoint surface the account/paymaster/factory actually use.
interface IEntryPoint {
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable to, uint256 amount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable to) external;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
}
