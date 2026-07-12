import { describe, it, expect, vi } from 'vitest';
import { SKResourceService } from './resources.service';

/**
 * Regression test for #501 — the "Move" action added to the Note details
 * surfaces (modal dialog + info panel) must start the map Modify interaction for
 * the note, regardless of how the details were reached (so it works from a
 * resource list, not only a map click). `startNoteModify` rebuilds the note's
 * map feature and hands it to the shared modify machinery.
 *
 * It only touches `this.fromCache` and `this.mapInteract`, so exercise it on a
 * bare prototype instance — no Angular DI (same approach as
 * note-details-sizing.spec.ts).
 */
type FakeMapInteract = {
  draw: { features: unknown };
  startModifying: ReturnType<typeof vi.fn>;
};

function svcWithNote(
  note: { position?: { latitude: number; longitude: number } } | null,
  mapInteract: FakeMapInteract
) {
  const svc = Object.create(SKResourceService.prototype) as SKResourceService;
  Object.assign(svc as unknown as Record<string, unknown>, {
    fromCache: () => (note ? ['note-1', note] : null),
    mapInteract
  });
  return svc;
}

describe('startNoteModify (#501)', () => {
  it('loads the note feature and starts the Modify interaction', () => {
    const mapInteract: FakeMapInteract = {
      draw: { features: null },
      startModifying: vi.fn()
    };
    const svc = svcWithNote(
      { position: { latitude: 25.5, longitude: -80.5 } },
      mapInteract
    );

    svc.startNoteModify('note-1');

    // a single note feature, tagged so onModifyEnd can identify it, is staged
    const features = mapInteract.draw.features as {
      getLength: () => number;
      item: (i: number) => { getId: () => string };
    };
    expect(features.getLength()).toBe(1);
    expect(features.item(0).getId()).toBe('note.note-1');
    expect(mapInteract.startModifying).toHaveBeenCalledWith({
      id: 'note-1',
      type: 'note'
    });
  });

  it('does nothing for a note with no position', () => {
    const mapInteract: FakeMapInteract = {
      draw: { features: null },
      startModifying: vi.fn()
    };
    const svc = svcWithNote({}, mapInteract);

    svc.startNoteModify('note-1');

    expect(mapInteract.startModifying).not.toHaveBeenCalled();
    expect(mapInteract.draw.features).toBeNull();
  });
});
