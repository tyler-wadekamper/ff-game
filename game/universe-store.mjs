import { createUniverseResolver } from './universe.mjs';
import { createLeague, botsUntilHuman, GameError } from './engine.mjs';
import { NFL_CLUBS, ROSTER_SIZE, hashText } from './config.mjs';

export function universeServices(data) {
  const resolve = createUniverseResolver(data);
  const context = (record) => {
    if (!record.universe) {
      if (record.state.version !== data.catalog.version)
        throw new GameError('This save uses a different source library.');
      if (!Number.isInteger(record.state.world) || !data.privateData.worlds[record.state.world])
        throw new GameError('This save has an invalid football world.');
      return {
        catalog: data.catalog,
        players: data.players ?? new Map(data.catalog.players.map((p) => [p.id, p])),
        world: data.privateData.worlds[record.state.world],
      };
    }
    const spec = record.universe;
    if (
      typeof spec.id !== 'string' ||
      !spec.id.length ||
      spec.id.length > 100 ||
      !Number.isInteger(spec.seed) ||
      spec.seed < 0 ||
      spec.seed > 0xffffffff ||
      !Number.isInteger(spec.season) ||
      spec.season < 1 ||
      spec.season > 100 ||
      (spec.legacyWorld !== undefined && !data.privateData.worlds[spec.legacyWorld]) ||
      (spec.outcomeSeed !== undefined &&
        (!Number.isInteger(spec.outcomeSeed) ||
          spec.outcomeSeed < 0 ||
          spec.outcomeSeed > 0xffffffff))
    )
      throw new GameError('This universe recovery recipe is invalid.');
    let value;
    try {
      value = resolve(spec);
    } catch (error) {
      throw new GameError(error.message);
    }
    value.players ??= new Map(value.catalog.players.map((p) => [p.id, p]));
    if (record.state && record.state.version !== value.catalog.version)
      throw new GameError('This universe save has a different player version.');
    return value;
  };
  return {
    context,
    baseCatalog: { ...data.catalog, rosterSize: ROSTER_SIZE, clubs: NFL_CLUBS, seasonYear: 2026 },
    create(options, source, seed, id) {
      const mode = options.mode ?? 'new';
      if (!['new', 'continue'].includes(mode))
        throw new GameError('Choose a new universe or continue a completed universe.');
      let spec;
      if (mode === 'continue') {
        if (!source || source.state.phase !== 'complete')
          throw new GameError('Finish the current season before continuing the same universe.');
        spec = source.universe
          ? { ...source.universe, season: source.universe.season + 1 }
          : {
              id,
              seed,
              baseVersion: data.catalog.version,
              season: 2,
              legacyWorld: source.state.world,
            };
      } else
        spec = {
          id,
          seed,
          season: 1,
          baseVersion: data.catalog.version,
          identityMode: 'real',
          realVersion: data.realPlayers.version,
          outcomeSeed: hashText(id + ':outcomes:' + seed),
        };
      const value = context({ universe: spec });
      const state = createLeague({
        name: options.name ?? 'Your Franchise',
        city:
          mode === 'continue'
            ? source.state.teams[source.state.human].abbreviation
            : (options.city ?? 'DET'),
        slot: options.slot ?? 6,
        seed: (seed ^ 0x7a3678b1) >>> 0,
        version: value.catalog.version,
        worlds: 1,
        seasonYear: value.catalog.seasonYear,
        universe: {
          id: spec.id,
          season: spec.season,
          year: value.catalog.seasonYear,
          label: 'Universe ' + spec.id.slice(0, 6).toUpperCase(),
          identityMode: spec.identityMode ?? 'fictional',
        },
        franchises: mode === 'continue' ? source.state.teams : null,
      });
      botsUntilHuman(state, value.catalog, value.players);
      return { state, universe: spec, context: value };
    },
  };
}
