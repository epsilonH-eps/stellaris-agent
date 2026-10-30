# Stellaris native bridge provenance

Upstream: https://github.com/Yidhar/stellaris-mcp

Pinned source: `6cc8e82013f88d7ef51d906f3cdfa44054b7a250` / `v0.5.1` (MIT; LICENSE retained here).

Official release ZIP SHA-256: `6b04403f7612605ad2beb3dd76e08d6fb671e27ca4e8deb6a7254a3ac2289097`.

Official DLL SHA-256: `33397bfb804c299ca289c358808abee64f1cd146478229de8170b2f984cc302d`.

Local cyberfish-0.1 DLL SHA-256: `00ea2aaf737484ee22cc2dfb27a0e6562b93ea7594e0161f9d731dcedaaf149d`.

Local modifications are preserved in `cyberfish-0.1.patch`:

- Correct civilian leader lookup through the ship handle instead of assuming fleet and ship handles coincide; include ship_id and leader_id.
- Add normal system-wide mining/research station orders using the current-build `CFleetBuildOrbitalStationCommand`, its native `IsValid` and session queue.
- Pin MinHook v1.3.4 and use shallow dependency fetches.

Build: Visual Studio 2022 Build Tools 17.14.42, x64 Release, CMake 4.4.4. Host tools are installed globally on C:. The bridge, its logs and settings stay in the project runtime folder; no game executable is overwritten.

Current runtime: **cyberfish-0.6.1**, SHA-256 `4a54662dd9c9555ccdf5eedaf6ef611f30d139dfc3459c2d3135d57363059d8e`.

The complete cumulative source changes, including added C++ files, are preserved in `cyberfish-0.6.1.patch`. Apply this patch to the pinned upstream commit; do not also apply earlier patches. Reverse-application checks pass against the exact source checkout. Earlier patches are retained as history.

Additional local changes include native game backbuffer evidence, camera/panel presentation, guarded military templates and reinforcement, full-generation foreign country handles, normal diplomacy proposals/responses, legal tradition/ascension candidates, primary-war state and defender war goals, and a dedicated informational declaration-of-war confirmation path. The custom dispatcher remains on the existing game-thread TaskQueue. It does not overwrite the game executable or bypass resource/command validation.

Council assignment uses the native AddToCouncil command and audits only three vanilla position classes. The generated SDK's swapped council database/null-object globals are corrected; a normal secretary-of-state appointment has been read back in the live game. Other modded/civic positions remain unadapted. The bounded defense scan exposes foreign fleets only where the player's native intel is high enough; foreign is not automatically hostile.

The normal war-goals opener is also included. A new live declaration has now exercised opening the window, posting a legal humiliation goal, closing the review and acknowledging the informational notice; each step was independently read back. This confirms that dialog path, not overall war strategy or victory.

Runtime artifacts live at `.local/native-bridge/runtime/cyberfish-0.6.1/`. Build products live in `.local/native-bridge/build/`. Source checkout lives at `(build workspace)`.

The separate read-only identity/research helpers under `native/research` use GPL-3.0-only code/data based on OGAS and retain their own license. They are not relicensed as MIT by this notice.

The tactics extension adds same-system normal merge commands with an engine deep-cloned fleet reference array, legal candidate queries, actual naval size and UI-formatted military power. Military power is Q15, confirmed with native formatting and the rendered fleet label; the previous decimal normalization is corrected. No multi-fleet live merge was available in the current world yet, so compiled and contract-tested is not reported as gameplay validation. Empty shipyard candidates now include bounded native refusal reasons, including enemy occupation.
