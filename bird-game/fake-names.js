// ── Fake name parts ──────────────────────────────────────────────────────────

// EASY: silly/funny — obviously made up
const SILLY = {
  shortPre: ['Boing','Flump','Wobble','Snork','Bumble','Splat','Squonk','Doodle',
             'Noodle','Twiddle','Fumble','Rumple','Bubble','Giggle','Wiggle',
             'Jiggle','Boggle','Blorp','Fizzle','Bibble','Wibble','Clonk','Honkle',
             'Plonk','Wuffle','Snibble','Flibble','Grumble','Tumble','Squibble',
             'Flooble','Zibble','Snuffler','Blorple','Yibble','Quibble','Snortle'],
  shortSuf: ['bird','finch','wren','chat','lark','beak','plop','wing','puff','bob',
             'flap','honk','bonk','toot','blorp','squeak','peep','clonk','wig',
             'boink','fizzer','doodler','bonker','noodler','blonker','squibble'],
  medAdj:   ['Wobbly','Giggly','Fluffy','Puffy','Fuzzy','Chubby','Grumpy','Sleepy',
             'Bouncy','Squishy','Bumbling','Tumbling','Shuffling','Waddling','Droopy',
             'Flappy','Sneezy','Doofy','Noodly','Blobby','Squiggly','Plonky',
             'Blundering','Lumpy','Honky','Sniffly','Boggle-eyed','Roly-poly',
             'Pudgy','Floopy','Snorting','Gurgling','Teetering','Flumping'],
  medNoun:  ['Boing','Flump','Splat','Squonk','Noodle','Doodle','Rumple','Bubble',
             'Wobble','Twiddle','Fumble','Giggle','Wiggle','Blorp','Fizzle','Bibble',
             'Honkle','Plonk','Squibble','Flibble','Wuffle','Zibble','Flooble',
             'Snortle','Yibble','Blorple','Quibble'],
  medSuf:   ['bird','finch','wren','chat','lark','puff','bob','honk','wig','peep',
             'noodler','bonker','doodler','wing','plonk','squibbler'],
  longScale:['Greater','Lesser','Common','Giant','Tiny','Enormous','Northern','Spotted',
             'Magnificent','Bumbling','Tremendous','Bewildering','Extraordinary'],
  longAdj:  ['Wobbly','Giggly','Fluffy','Chubby','Bouncy','Squishy','Doofy','Flappy',
             'Blotchy','Pudgy','Sneezy','Droopy','Noodly','Lumpy','Blobby','Honky',
             'Roly-poly','Boggle-eyed','Squiggly','Floopy','Teetering','Gurgling'],
  longNoun: ['Boing','Flump','Splat','Noodle','Doodle','Bubble','Wobble','Fizzle',
             'Honkle','Plonk','Squonk','Bibble','Wuffle','Blorp','Squibble','Snortle'],
  longSuf:  ['bird','finch','wren','lark','puff','honk','chat','wig','noodler','bonker'],
};

// MEDIUM: plausible invented names — all three lengths
const PLAUSIBLE = {
  shortPre: ['Grey','Marsh','Blotch','Fen','Dusk','Mud','Stone','Rust','Buff','Dun',
             'Brack','Mire','Tarn','Sedge','Crag','Silt','Heath','Moor','Peat','Holt',
             'Gorse','Brake','Holm','Knoll','Copse','Shale','Dale','Brae','Quag'],
  shortSuf: ['snipe','chat','wing','wren','finch','bird','bill','cap','lark','back',
             'duck','swift','tern','hawk','dive','creep','perch','brush'],
  medSimple:['Russet','Dusky','Pale','Rufous','Brown','Tawny','Sooty','Ashy',
             'Barred','Streaked','Slender','Speckled','Mottled','Dappled','Ochre',
             'Sallow','Dingy','Smudgy','Blotched','Grizzled'],
  medHyphen:['Short-billed','White-throated','Long-tailed','Red-faced','Dark-backed',
             'Thin-billed','Broad-winged','Deep-chested','Stout-legged','Sharp-winged'],
  medMod:   ['Thorn','Bell','Crow','Gap','Mud','Dust','Crest','Brush','Marsh','Stone',
             'Cliff','Reed','Fen','Clatter','Creep','Rattle','Gorse','Sedge','Mire',
             'Brake','Shale','Brack','Quag','Holt','Dale'],
  medType:  ['wren','chat','finch','bird','wing','warbler','creeper','runner','diver',
             'shrike','martin','swift','hawk','lark'],
  longColor:['Pale','Golden','Black','Rufous','White','Buff','Dusky','Russet','Streaked',
             'Barred','Spotted','Sooty','Ash','Ochre','Tawny','Smudgy','Grizzled'],
  longPart: ['crowned','browed','breasted','vented','winged','backed','capped','fronted',
             'bellied','throated','billed','rumped','tailed','naped','faced','shouldered'],
  longHab:  ['Dust','Whistle','Crest','Bell','Mud','Crown','Thorn','Creep','Marsh','Reed',
             'Cliff','Mire','Heath','Rattle','Gap','Sedge','Gorse','Brake','Dale','Shale'],
  longType: ['wren','finch','bird','chat','warbler','runner','shrike','diver','lark','hawk'],
  scale:    ['Lesser','Greater','Common','Northern','Southern','Eastern','Western','Spotted'],
};

// HARD: follows real bird naming conventions — subtle and convincing
// Three distinct formats, one per length:
//   short  → "Color-bodypart Type"            e.g. Rufous-bellied Warbler
//   medium → "Scale Color-bodypart Type"       e.g. Lesser Yellow-throated Flycatcher
//   long   → "Geographic Color-bodypart Type"  e.g. Himalayan Black-crowned Babbler
const SNEAKY = {
  color:    ['Yellow','Red','Black','White','Blue','Purple','Golden','Rufous','Chestnut',
             'Olive','Grey','Brown','Tawny','Orange','Cinnamon','Crimson','Indigo','Scarlet',
             'Buff','Ochre','Slate','Rusty','Sooty','Fulvous','Vinous','Isabelline',
             'Pale','Dark','Dusky','Ash','Ferruginous','Lavender','Umber'],
  bodyPart: ['crowned','throated','backed','winged','breasted','bellied','faced','headed',
             'capped','vented','rumped','tailed','billed','footed','cheeked','eared','browed',
             'fronted','collared','naped','shouldered','flanked','ringed','spotted','barred'],
  type:     ['Warbler','Tanager','Finch','Sparrow','Flycatcher','Vireo','Thrush','Wren',
             'Nuthatch','Kingfisher','Hummingbird','Hawk','Dove','Plover','Heron','Bunting',
             'Grosbeak','Swallow','Pipit','Babbler','Sunbird','Honeyeater','Manakin',
             'Trogon','Barbet','Woodpecker','Pitta','Monarch','Fantail','Laughingthrush',
             'Cisticola','Prinia','Bulbul','White-eye','Flowerpecker','Leafbird',
             'Chat','Robin','Redstart','Wheatear','Nightjar','Shortwing','Drongo'],
  scale:    ['Lesser','Greater','Common','Little','Slender','Pale','Plain','Streaked'],
  geo:      ['Eastern','Western','Northern','Southern','Eurasian','African','Asian',
             'American','Himalayan','Amazonian','Andean','Sumatran','Bornean',
             'Mountain','Forest','Highland','Coastal','Island','Desert','Marsh'],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const usedFakeNames = new Set();

function generateFakeName() {
  let name, attempts = 0;
  const style = getStyle();
  do {
    const len = Math.floor(Math.random() * 3); // 0=short, 1=medium, 2=long
    if (style === 'easy') {
      if (len === 0) {
        name = pick(SILLY.shortPre) + pick(SILLY.shortSuf);
      } else if (len === 1) {
        name = `${pick(SILLY.medAdj)} ${pick(SILLY.medNoun)}${pick(SILLY.medSuf)}`;
      } else {
        name = `${pick(SILLY.longScale)} ${pick(SILLY.longAdj)} ${pick(SILLY.longNoun)}${pick(SILLY.longSuf)}`;
      }
    } else if (style === 'medium') {
      if (len === 0) {
        name = pick(PLAUSIBLE.shortPre) + pick(PLAUSIBLE.shortSuf);
      } else if (len === 1) {
        const adj = Math.random() < 0.3 ? pick(PLAUSIBLE.medHyphen) : pick(PLAUSIBLE.medSimple);
        name = `${adj} ${pick(PLAUSIBLE.medMod)}${pick(PLAUSIBLE.medType)}`;
      } else {
        if (Math.random() < 0.7) {
          name = `${pick(PLAUSIBLE.longColor)}-${pick(PLAUSIBLE.longPart)} ${pick(PLAUSIBLE.longHab)}${pick(PLAUSIBLE.longType)}`;
        } else {
          name = `${pick(PLAUSIBLE.scale)} ${pick(PLAUSIBLE.longHab)}${pick(PLAUSIBLE.longType)}`;
        }
      }
    } else { // hard — always "Color-bodypart Type" so it matches the real birds shown
      name = `${pick(SNEAKY.color)}-${pick(SNEAKY.bodyPart)} ${pick(SNEAKY.type)}`;
    }
    attempts++;
  } while (usedFakeNames.has(name) && attempts < 100);
  usedFakeNames.add(name);
  return name;
}
