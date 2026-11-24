// The protected lane never becomes the legacy state request. A proof is
// meaningful only for the same capture, request, match and connection.
module reconnect_proof {
  pure def hostAction(capable: bool, protected: bool, phantom: bool, nativeReady: bool, allOwnersConfirmed: bool): str =
    if (not(protected)) "legacy"
    else if (not(capable) or phantom) "ignore"
    else if (not(nativeReady) or not(allOwnersConfirmed)) "wait"
    else "proof"

  pure def canApply(
    expected: int, proof: int, fromCurrentHost: bool, sameEpoch: bool, sameGeneration: bool, timely: bool
  ): bool =
    expected > 0 and proof == expected and fromCurrentHost and sameEpoch and sameGeneration and timely

  run mixedHostDoesNotInterpretProtectedRequestTest = assert(hostAction(false, true, false, true, true) == "ignore")
  run independentPhantomClassificationCannotProofTest = assert(hostAction(true, true, true, true, true) == "ignore")
  run nativeCaptureIsTheOnlyProtectedProofTest = assert(
    hostAction(true, true, false, false, true) == "wait" and hostAction(true, true, false, true, true) == "proof"
  )
  run bystanderPredictionCannotProofTest = assert(hostAction(true, true, false, true, false) == "wait")

  pure def canQueue(request: int, pending: int, handedOff: int, stillCurrent: bool, timely: bool): bool =
    stillCurrent and timely and request > 0 and request >= handedOff and request > pending

  run handoffAllowsBoundedCurrentExplicitRetryTest = assert(
    canQueue(9, 0, 9, true, true) and
    canQueue(10, 0, 9, true, true) and
    not(canQueue(10, 10, 9, true, true)) and
    not(canQueue(8, 0, 9, true, true)) and
    not(canQueue(10, 0, 9, false, true)) and
    not(canQueue(10, 0, 9, true, false))
  )

  run opaqueStaleOrExpiredCannotApplyTest = assert(
    not(canApply(9, 0, true, true, true, true)) and
    not(canApply(9, 8, true, true, true, true)) and
    not(canApply(9, 9, false, true, true, true)) and
    not(canApply(9, 9, true, false, true, true)) and
    not(canApply(9, 9, true, true, false, true)) and
    not(canApply(9, 9, true, true, true, false)) and
    canApply(9, 9, true, true, true, true)
  )
}
