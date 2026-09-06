// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint, IPaymaster, PackedUserOperation} from "./AAInterfaces.sol";
import {Owned} from "../base/InHouse.sol";

/**
 * @title LuvPaymaster — verifying paymaster (gas sponsorship)
 * @notice Replaces the hosted paymaster service: the platform sponsors users' gas so claiming
 *         rewards and interacting never requires holding ETH. The backend approves each
 *         UserOperation off-chain (rate limits, abuse checks — same policy layer that verifies
 *         tweets/posts) and signs it; only ops carrying that signature get sponsored.
 *
 * paymasterAndData layout (ERC-4337 v0.7):
 *   [0:20]  paymaster address
 *   [20:36] paymasterVerificationGasLimit
 *   [36:52] paymasterPostOpGasLimit
 *   [52:58] validUntil  (uint48)
 *   [58:64] validAfter  (uint48)
 *   [64:]   backend signature (65 bytes, EIP-191 over getHash(...))
 */
contract LuvPaymaster is IPaymaster, Owned {
    IEntryPoint public immutable entryPoint;
    address public verifyingSigner;

    event SignerUpdated(address indexed prev, address indexed next);

    error NotEntryPoint();
    error BadPaymasterDataLength();

    modifier onlyEntryPoint() {
        if (msg.sender != address(entryPoint)) revert NotEntryPoint();
        _;
    }

    constructor(IEntryPoint entryPoint_, address verifyingSigner_) Owned(msg.sender) {
        if (verifyingSigner_ == address(0)) revert ZeroAddress();
        entryPoint = entryPoint_;
        verifyingSigner = verifyingSigner_;
    }

    // ───────────────────────── validation ─────────────────────────

    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        external
        view
        onlyEntryPoint
        returns (bytes memory context, uint256 validationData)
    {
        (uint48 validUntil, uint48 validAfter, bytes calldata sig) = _parse(userOp.paymasterAndData);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", getHash(userOp, validUntil, validAfter))
        );
        bool sigOk = _recover(digest, sig) == verifyingSigner;
        // validationData: failure flag | validUntil << 160 | validAfter << 208
        validationData =
            (sigOk ? 0 : 1) | (uint256(validUntil) << 160) | (uint256(validAfter) << 208);
        return ("", validationData);
    }

    function postOp(PostOpMode, bytes calldata, uint256, uint256) external onlyEntryPoint {}

    /// The digest the backend signs to sponsor an op. Binds every gas-relevant field plus
    /// chain + paymaster so a voucher can't be replayed elsewhere.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function _parse(bytes calldata paymasterAndData)
        private
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata sig)
    {
        if (paymasterAndData.length != 64 + 65) revert BadPaymasterDataLength();
        validUntil = uint48(bytes6(paymasterAndData[52:58]));
        validAfter = uint48(bytes6(paymasterAndData[58:64]));
        sig = paymasterAndData[64:];
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }

    // ───────────────────────── owner: signer / deposit / stake ─────────────────────────

    function setVerifyingSigner(address s) external onlyOwner {
        if (s == address(0)) revert ZeroAddress();
        emit SignerUpdated(verifyingSigner, s);
        verifyingSigner = s;
    }

    function deposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        entryPoint.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        entryPoint.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        entryPoint.withdrawStake(to);
    }

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    receive() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }
}
