/** Once signaling has lost slot zero, only recent gameplay traffic on its current RTC connection can keep the guest playing. */
export function hostGameConnected(
  pcState: RTCPeerConnectionState | undefined,
  iceState: RTCIceConnectionState | undefined,
  gameChannelOpen: boolean,
  lastProgressAt: number | undefined,
  now: number,
): boolean {
  const iceDown = iceState === 'disconnected' || iceState === 'closed' || iceState === 'failed';
  const connected =
    pcState === 'connected' || (pcState === undefined && (iceState === 'connected' || iceState === 'completed'));
  // A closed mobile tab can leave both a connected transport and open channels
  // behind for seconds. Two seconds without fresh controller input or decoded video span ~120 game frames.
  return !!(connected && !iceDown && gameChannelOpen && lastProgressAt !== undefined && now - lastProgressAt < 2000);
}
