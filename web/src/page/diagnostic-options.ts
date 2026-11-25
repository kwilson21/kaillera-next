/** Player-supplied debugging switches apply only on the local development server. */
export function diagnosticOptions(
  location: Pick<Location, 'hostname' | 'search'>,
  readStored: (key: string) => string | null,
) {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const params = new URLSearchParams(local ? location.search : '');
  const stored = (key: string) => (local ? readStored(key) : null);
  const enabled = (name: string, key: string) => (params.get(name) ?? stored(key)) === '1';
  const devBuild = params.get('debug') === '1' || stored('KN_DEV_BUILD') === '1';
  const debug = stored('kn-debug') === '1';
  const cadence = params.get('canvasCadence') === '1';
  const desync = params.get('desync');
  return Object.freeze({
    local,
    devBuild,
    interactive: devBuild || params.has('knDiag') || debug,
    console: params.has('debug'),
    verbose: params.has('debug') || params.get('verbose') === '1' || debug,
    light: params.get('knperf') === 'light',
    trace: params.get('kntrace') === '1',
    deep: params.get('kndiag') === 'deep' || desync === 'deep',
    liveFlush: params.get('knflush') === 'live',
    cadence,
    tickProfile: cadence || enabled('tickProfile', 'kn-tick-profile'),
    rollbackProbe: enabled('rbProbe', 'kn-rb-probe'),
    tickReturnTrace: enabled('tickReturnTrace', 'kn-tick-return-trace'),
    shadowVerbose: params.get('shadowVerbose') === '1',
    forceDesyncTick: params.get('forceDesyncTick') === '1',
    desync,
  });
}
