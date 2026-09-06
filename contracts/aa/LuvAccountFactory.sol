// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEntryPoint} from "./AAInterfaces.sol";
import {LuvAccount} from "./LuvAccount.sol";

/**
 * @title LuvProxy — minimal in-house ERC-1967 proxy
 * @notice Delegates everything to the implementation stored in the ERC-1967 slot. Written
 *         in-repo (no OZ Proxy import) so the whole wallet stack is auditable in one place.
 */
contract LuvProxy {
    bytes32 internal constant _IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address impl, bytes memory initData) {
        assembly {
            sstore(_IMPL_SLOT, impl)
        }
        if (initData.length > 0) {
            (bool ok, bytes memory err) = impl.delegatecall(initData);
            if (!ok) {
                assembly {
                    revert(add(err, 32), mload(err))
                }
            }
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(_IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}

/**
 * @title LuvAccountFactory — counterfactual smart-account deployment
 * @notice Replaces the hosted AA account factory. The backend derives each social identity's
 *         wallet address with getAddress(owner, salt) BEFORE anything is deployed — welcome
 *         drops and rewards can be sent to the address immediately; the account materializes
 *         on the user's first UserOperation (via ERC-4337 initCode) or an explicit call here.
 */
contract LuvAccountFactory {
    LuvAccount public immutable accountImplementation;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor(IEntryPoint entryPoint) {
        accountImplementation = new LuvAccount(entryPoint);
    }

    /// Idempotent: returns the existing account if already deployed (4337 factory convention).
    function createAccount(address owner, uint256 salt) external returns (LuvAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length > 0) {
            return LuvAccount(payable(predicted));
        }
        account = LuvAccount(
            payable(
                new LuvProxy{salt: bytes32(salt)}(
                    address(accountImplementation), abi.encodeCall(LuvAccount.initialize, (owner))
                )
            )
        );
        emit AccountCreated(address(account), owner, salt);
    }

    /// Counterfactual address for (owner, salt).
    function getAddress(address owner, uint256 salt) public view returns (address) {
        bytes32 codeHash = keccak256(
            abi.encodePacked(
                type(LuvProxy).creationCode,
                abi.encode(address(accountImplementation), abi.encodeCall(LuvAccount.initialize, (owner)))
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), bytes32(salt), codeHash)))));
    }
}
