// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Minimal view surface of 0G's official InferenceServing contract.
/// @dev Mainnet: 0x47340d900bdFec2BD393c626E12ea0656F938d84 (chain 16661).
///      Galileo testnet: 0xa79F4c8311FF93C06b8CfB403690cc987c93F91E (chain 16602).
///      Field order is copied exactly from 0G's deployed `ServiceStruct`.
interface IInferenceServing {
    struct Service {
        address provider;
        string serviceType;
        string url;
        uint256 inputPrice;
        uint256 outputPrice;
        uint256 updatedAt;
        string model;
        string verifiability;
        string additionalInfo;
        address teeSignerAddress;
        bool teeSignerAcknowledged;
    }

    function getService(address provider) external view returns (Service memory);
}
