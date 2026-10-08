import { useState } from 'preact/hooks';
import { queryParam } from '../route.ts';
import { usePref } from '../store.ts';
import { Positions } from './Positions.tsx';
import { Prices } from './Prices.tsx';

type Sub = 'posiciones' | 'precios';

/** Inversiones: what is held, at what cost (Posiciones), and how each stock goes against its entry and target (Precios). */
export function Investments() {
  const [saved, save] = usePref<Sub>('inv:sub', 'posiciones');
  const asked = queryParam('ver');
  // A link can ask for one view (`?ver=precios`); after that the buttons decide, and the choice is remembered.
  const [sub, setSub] = useState<Sub>(asked === 'precios' || asked === 'posiciones' ? asked : saved);
  const pick = (s: Sub) => {
    setSub(s);
    save(s);
  };
  return (
    <>
      <div class="seg subtabs" role="group" aria-label="Vista de inversiones">
        <button type="button" aria-pressed={sub === 'posiciones'} onClick={() => pick('posiciones')}>
          Posiciones
        </button>
        <button type="button" aria-pressed={sub === 'precios'} onClick={() => pick('precios')}>
          Precios y objetivos
        </button>
      </div>
      {sub === 'posiciones' ? <Positions /> : <Prices />}
    </>
  );
}
