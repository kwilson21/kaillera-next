// A gameplay reconnect is offered by the lower slot. Its timeout, RTC failure,
// and rejected offer can all report the same attempt before the retry delay ends.
module reconnect_attempt {
  const OWN_ATTEMPT: bool
  var s: {phase: str, pc: int, tries: int, retries: List[int], offers: Set[int], replacedNewer: bool, sentStale: bool}

  action init = s' = {phase: "offering", pc: 1, tries: 1, retries: [], offers: Set(1), replacedNewer: false, sentStale: false}

  action attemptFailed(id: int): bool = all {
    id > 0, id <= s.pc, s.phase.in(Set("offering", "backoff")), s.retries.length() < 2,
    if (OWN_ATTEMPT and (s.phase != "offering" or s.pc != id)) s' = s
    else if (s.tries >= 3) s' = s.with("phase", "ended").with("retries", [])
    else s' = s.with("phase", "backoff").with("retries", s.retries.append(id)),
  }

  action retry = all {
    s.retries.length() > 0, s.phase.in(Set("offering", "backoff")), s.pc < 5,
    s' = { ...s, phase: "offering", pc: s.pc + 1, tries: s.tries + 1, retries: s.retries.tail(),
      offers: s.offers.union(Set(s.pc + 1)), replacedNewer: s.replacedNewer or s.retries.head() != s.pc },
  }

  // A recovered channel, a replacement connection, or session shutdown ends
  // this retry's authority. An outstanding async offer can still complete.
  action end = all {
    s.phase != "ended", s' = s.with("phase", "ended").with("retries", []),
  }

  action finishOffer(id: int): bool = all {
    s.offers.contains(id),
    val stale = s.pc != id or s.phase == "ended"
    s' = s.with("offers", s.offers.exclude(Set(id))).with("sentStale", s.sentStale or (not(OWN_ATTEMPT) and stale)),
  }

  action step = any { nondet id = 1.to(5).oneOf(); attemptFailed(id), retry, end,
    nondet id = 1.to(5).oneOf(); finishOffer(id), s' = s }
  val oneRetryPerAttempt = s.retries.length() <= 1 and not(s.replacedNewer)
  val onlyCurrentOffersAreSent = not(s.sentStale)
  val allHold = oneRetryPerAttempt and onlyCurrentOffersAreSent and s.tries <= 3

  run timeoutThenFailedTest = init.then(attemptFailed(1)).then(attemptFailed(1)).expect(oneRetryPerAttempt == OWN_ATTEMPT)
  run lateOfferAfterReplacementTest = init.then(attemptFailed(1)).then(retry).then(finishOffer(1))
    .expect(onlyCurrentOffersAreSent == OWN_ATTEMPT)
  run recoveredDuringBackoffTest = init.then(attemptFailed(1)).then(end).expect(s.phase == "ended" and s.retries.length() == 0)
  run attemptsExhaustedTest = init.then(attemptFailed(1)).then(retry).then(attemptFailed(2)).then(retry).then(attemptFailed(3))
    .expect(s.phase == "ended" and s.tries == 3)
}
module reconnect_attempt_before { import reconnect_attempt(OWN_ATTEMPT = false).* }
module reconnect_attempt_fixed { import reconnect_attempt(OWN_ATTEMPT = true).* }
