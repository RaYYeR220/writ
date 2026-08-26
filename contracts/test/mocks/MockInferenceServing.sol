// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IInferenceServing} from "../../src/interfaces/IInferenceServing.sol";

contract MockInferenceServing is IInferenceServing {
    mapping(address => Service) private _services;

    function set(
        address provider,
        string memory model,
        string memory verifiability,
        address teeSigner,
        bool acknowledged
    ) external {
        Service storage s = _services[provider];
        s.provider = provider;
        s.serviceType = "chatbot";
        s.url = "https://example.invalid";
        s.model = model;
        s.verifiability = verifiability;
        s.teeSignerAddress = teeSigner;
        s.teeSignerAcknowledged = acknowledged;
    }

    /// @dev Mirrors the live contract, which reverts rather than returning an empty struct.
    function getService(address provider) external view returns (Service memory) {
        if (_services[provider].provider == address(0)) revert ServiceNotExist(provider);
        return _services[provider];
    }
}
