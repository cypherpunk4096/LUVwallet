// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccount, IEntryPoint, PackedUserOperation} from "./AAInterfaces.sol";

/**
 * @title LuvAccount — in-house ERC-4337 smart account
 * @notice The platform's smart wallet: one per social identity, deployed counterfactually by
 *         LuvAccountFactory. Replaces the hosted account-factory wallets with clean-house code.
 *
 * FEATURES
 *   • ERC-4337 v0.7 (`validateUserOp`, PackedUserOperation) against the canonical EntryPoint.
 *   • Owner-key ECDSA validation; `execute`/`executeBatch` callable by EntryPoint or owner.
 *   • ERC-1271 (`isValidSignature`) so the account can sign for dapps/permits.
 *   • ERC-1967 upgradeable (owner-gated `upgradeTo`) — deliberate, see 8141 note.
 *   • Receives ETH and any token (ERC-721/1155 receiver hooks included).
 *
 * EIP-8141 READINESS (native account abstraction, "Frame Transactions", CFI for Hegotá):
 *   8141 replaces 4337's contract EntryPoint with protocol-level verification frames that the
 *   account terminates via the new APPROVE opcode (0xaa). Existing 4337 accounts cannot be
 *   reused as-is, and APPROVE does not exist on any live chain yet — so "implement as 8141"
 *   is not deployable today. This account is structured for a one-step migration instead:
 *     1. all signer policy is isolated in `_isValidSigner(hash, sig)` — the only auth root;
 *     2. the account is upgradeable, so when Hegotá ships, an implementation upgrade adds the
 *        verify-frame handler (calling APPROVE after `_isValidSigner`) without moving accounts,
 *        addresses, or assets;
 *     3. ERC-1271 already exposes signature validity via STATICCALL, matching 8141's
 *        VERIFY-mode (staticcall) semantics.
 */
contract LuvAccount is IAccount {
    // ERC-1967 implementation slot (keccak("eip1967.proxy.implementation") - 1)
    bytes32 internal constant _IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    IEntryPoint public immutable entryPoint;

    address public accountOwner;

    event LuvAccountInitialized(address indexed owner);
    event OwnerUpdated(address indexed prev, address indexed next);
    event Upgraded(address indexed implementation);
    event Executed(address indexed target, uint256 value, bytes data);

    error NotEntryPointOrOwner();
    error NotSelfOrOwner();
    error AlreadyInitialized();
    error ZeroAddress();
    error LengthMismatch();
    error CallFailed(bytes result);

    modifier onlyEntryPointOrOwner() {
        if (msg.sender != address(entryPoint) && msg.sender != accountOwner) revert NotEntryPointOrOwner();
        _;
    }

    /// Owner acting directly, or the account acting on itself via execute() (i.e. a UserOp).
    modifier onlySelfOrOwner() {
        if (msg.sender != address(this) && msg.sender != accountOwner) revert NotSelfOrOwner();
        _;
    }

    constructor(IEntryPoint entryPoint_) {
        entryPoint = entryPoint_;
        accountOwner = address(1); // brick the implementation contract itself
    }

    /// Proxy initializer (called once by the factory).
    function initialize(address owner_) external {
        if (accountOwner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        accountOwner = owner_;
        emit LuvAccountInitialized(owner_);
    }

    // ───────────────────────── ERC-4337 ─────────────────────────

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData)
    {
        if (msg.sender != address(entryPoint)) revert NotEntryPointOrOwner();
        validationData = _isValidSigner(userOpHash, userOp.signature) ? 0 : 1;
        if (missingAccountFunds != 0) {
            (bool ok,) = msg.sender.call{value: missingAccountFunds}("");
            (ok); // EntryPoint verifies its own balance; a failed prefund fails there
        }
    }

    // ───────────────────────── execution ─────────────────────────

    function execute(address target, uint256 value, bytes calldata data) external onlyEntryPointOrOwner {
        _call(target, value, data);
    }

    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        onlyEntryPointOrOwner
    {
        if (targets.length != values.length || targets.length != datas.length) revert LengthMismatch();
        for (uint256 i = 0; i < targets.length; i++) {
            _call(targets[i], values[i], datas[i]);
        }
    }

    function _call(address target, uint256 value, bytes calldata data) private {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) revert CallFailed(result);
        emit Executed(target, value, data);
    }

    // ───────────────────────── signer policy (single auth root — see 8141 note) ─────────────

    /// The ONLY place signatures are judged. 4337 today; an 8141 verify-frame handler reuses
    /// this untouched. Accepts the owner key over the EIP-191 eth-signed digest of `hash`.
    function _isValidSigner(bytes32 hash, bytes calldata sig) internal view returns (bool) {
        if (sig.length != 65) return false;
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        if (v != 27 && v != 28) return false;
        address recovered = ecrecover(ethHash, v, r, s);
        return recovered != address(0) && recovered == accountOwner;
    }

    /// ERC-1271
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return _isValidSigner(hash, sig) ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    // ───────────────────────── admin ─────────────────────────

    function setOwner(address next) external onlySelfOrOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnerUpdated(accountOwner, next);
        accountOwner = next;
    }

    /// Upgrade the proxy implementation (the EIP-8141 migration hook).
    function upgradeTo(address impl) external onlySelfOrOwner {
        if (impl == address(0)) revert ZeroAddress();
        assembly {
            sstore(_IMPL_SLOT, impl)
        }
        emit Upgraded(impl);
    }

    // ───────────────────────── EntryPoint gas deposit ─────────────────────────

    function getDeposit() external view returns (uint256) {
        return entryPoint.balanceOf(address(this));
    }

    function addDeposit() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }

    function withdrawDepositTo(address payable to, uint256 amount) external onlySelfOrOwner {
        entryPoint.withdrawTo(to, amount);
    }

    // ───────────────────────── receivers ─────────────────────────

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }
}
