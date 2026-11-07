// NEMonster: the monster of a transaction hash, ported 1:1 from the official NEM Nano Wallet
// (nanowallet/src/app/modules/NEMonster/setup/NEMonster.controller.js). The same hash gives the same
// monster there and here, so a collection caught in one wallet shows up in the other.
// Pure functions only (no imports), so they can be checked without the rest of the app.

const COLORS = ['#F45B69', '#4286f4', '#42f4b6', '#8941f4', '#f49d41', '#ce3333', '#a9ce33', '#33ce35', '#338ace', '#ce3385', '#f4ce42', '#cee5ce'];
const GRADS = ['grad', '', 'grad2', '', 'grad3', '', 'grad4', '', 'grad5', '', 'grad6', '', 'grad7', '', 'grad8', '', 'grad9', '', '', '', '', '', ''];
const BODIES = ['monster', 'monster2'];
const HAIRS = ['hair', 'hair2'];
const EYES = ['eyes', 'eyes2', 'eyes3', 'eyes4', 'eyes5', 'eyes2', 'eyes2', 'eyes6', 'eyes6'];
const IRISES = ['iris', 'iris2', 'iris3', 'iris4', 'iris5', 'iris6', 'iris7', 'iris8', 'iris9'];
const MOUTHS = ['mouth', 'mouth2', 'mouth3', 'mouth4', 'mouth5', 'mouth6'];
const TEETH = ['teeth', 'teeth3', 'teeth3', 'teeth4', ''];
const ROLLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const NAMES_1 = ['The', 'Decayface', 'Wispface', 'Fetidmorph', 'Mc', 'Glowmirage', 'Forsaken', 'Enraged', 'Grumpy', 'Slender', 'Horror', 'Glacial', 'Crowned', 'Cave', 'Angry', 'Disfigured', 'The Furry', 'The Fiery Storm', 'The Elusive', 'The Brutal', 'The Diabolical', 'The Bewitched', 'The Agile', 'The Giant', 'Glowteeth', 'Thunderseeker', 'Duskcrackle', 'The Long-Horned Terror', 'The Crowned Harlequin', 'The Screeching', 'Hollowface', 'The Meager', 'The Grim Vision', 'The Chaotic', 'The Half', 'The Savage Corpse', 'Acidhound', 'The Undead', 'The shy', 'The Cold-Blooded', 'The Ugly', 'The Primitive'];
const NAMES_2 = ['Phenomenon', 'Teeth', 'Savage', 'Beast', 'Lion', 'Gargoyle', 'Monster', 'Dragon', 'Viper', 'Vampier', 'Buffalo', 'Leopard', 'Freak', 'Rot Bear', 'Entity', 'Ooze', 'Slayer Owl', 'Lich', 'Crocodile', 'Phoenix', 'Stinkmask', 'Dweller', 'Hunter', 'Sun Rhino', 'Jackal', 'Butcher Viper', 'Spider', 'Dog', 'Hellmonster', 'Skeleton', 'Lon', 'Jeff', 'Kristof', 'Nelson', 'Alexandra'];

export interface Monster {
  color: string; // body colour (css)
  body: string; // css class: monster | monster2
  hair: string; // css class: hair | hair2
  eyes: string; // css class: eyes ... eyes6
  iris: string; // css class: iris ... iris9
  mouth: string; // css class: mouth ... mouth6
  teeth: string; // css class: teeth ... teeth4, or '' for none
  grad: string; // css class of the body gradient: grad ... grad9, or '' for none
  irisColor: string; // '#000' most of the time, a colour for the rare ones
  name1: string;
  name2: string;
}

/** djb2 with the exact int32 / double behaviour of the original JavaScript (do not "fix" it). */
export function djb2(text: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) + hash + text.charCodeAt(i);
  }
  return hash;
}

/** The monster of a transaction hash (the hash string exactly as NIS1 reports it, upper-case hex). */
export function monsterFromHash(txHash: string): Monster {
  const pick = <T>(list: T[], seed: number): { index: number; value: T } => {
    const index = Math.abs(djb2(txHash, seed) % list.length);
    return { index, value: list[index] };
  };
  const color = pick(COLORS, 5381).value;
  const body = pick(BODIES, 3581).value;
  const hair = pick(HAIRS, 1581).value;
  const eyes = pick(EYES, 2881);
  const mouth = pick(MOUTHS, 7881).value;
  const teeth = pick(TEETH, 4528).value;
  const name1 = pick(NAMES_1, 1526).value;
  const name2 = pick(NAMES_2, 4518).value;
  const grad = pick(GRADS, 1258).value;
  const irisTint = pick(COLORS, 1250).value;
  const roll = pick(ROLLS, 1112).value;
  return {
    color,
    body,
    hair,
    eyes: eyes.value,
    iris: IRISES[eyes.index], // the iris follows the eyes, as in the original
    mouth,
    teeth,
    grad,
    irisColor: roll < 9 ? '#000' : irisTint, // only 1 in 5 monsters has coloured irises
    name1,
    name2,
  };
}

/** Everybody starts with this one. */
export const STARTER_MONSTER: Monster = {
  color: '#42bcf4',
  body: 'monster',
  hair: 'hair',
  eyes: 'eyes3',
  iris: 'iris3',
  mouth: 'mouth',
  teeth: 'teeth3',
  grad: 'grad',
  irisColor: '#000',
  name1: 'Jeff The Monster Slayer',
  name2: '',
};
