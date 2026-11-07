// 投票鍵(Voting Key)のリンク／解除: どのリンクを送るかの判定。通信なし。
// Run: npx tsx dev-tests/voting-keys.test.ts
import {
  DEFAULT_VOTING_LIMITS, checkVotingRange, defaultVotingRange, isVotingPublicKeyHex, parseEpoch, planVotingLink, planVotingUnlink,
  sortVotingKeys, unlinksStillMatch, votingLifetime,
} from '../src/lib/symbol/votingKeys';

let fails = 0, checks = 0;
function ok(cond: boolean, what: string, extra?: unknown) { checks++; if (!cond) { fails++; console.log('FAIL:', what, extra ?? ''); } }
const json = (x: unknown) => JSON.stringify(x);
const err = (x: { ok: boolean }) => (x as { error?: string }).error;

const k = (c: string) => c.repeat(96);
const A = k('A'), B = k('B'), C = k('C'), D = k('D');
const none: never[] = [];
const one = [{ publicKey: A, startEpoch: 100, endEpoch: 200 }];

// --- key / epoch syntax
ok(isVotingPublicKeyHex(k('a')) && !isVotingPublicKeyHex('a'.repeat(64)) && !isVotingPublicKeyHex(k('g')) && !isVotingPublicKeyHex(k('a') + '0'), 'voting key is 96 hex chars (a 64-char account key is not one)');
ok(parseEpoch('1') === 1 && parseEpoch('4294967295') === 4294967295 && parseEpoch('4294967296') === null, 'epoch range 1 … uint32 max');
ok(parseEpoch('') === null && parseEpoch('0') === null && parseEpoch('-3') === null && parseEpoch('1.5') === null && parseEpoch('1e3') === null && parseEpoch(' 5') === null, 'epoch: digits only, no zero');
ok(votingLifetime(100, 100) === 1 && votingLifetime(100, 127) === 28, 'lifetime counts both ends');

// --- link
ok(json(planVotingLink(none, { publicKey: A, startEpoch: 100, endEpoch: 200 })) === json({ ok: true, links: [{ publicKey: A, startEpoch: 100, endEpoch: 200, link: true }] }), 'link one key');
ok(json(planVotingLink(none, { publicKey: ` ${A.toLowerCase()} `, startEpoch: 100, endEpoch: 127 })) === json({ ok: true, links: [{ publicKey: A, startEpoch: 100, endEpoch: 127, link: true }] }), 'a typed key (lower case, spaces) is linked trimmed, in upper case; the minimum lifetime (28) passes');
ok(err(planVotingLink(none, { publicKey: 'abc', startEpoch: 100, endEpoch: 200 })) === 'invalid_key', 'a bad key is refused');
ok(err(planVotingLink(none, { publicKey: 'a'.repeat(64), startEpoch: 100, endEpoch: 200 })) === 'invalid_key', 'an account public key (64 chars) is refused');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: NaN, endEpoch: 200 })) === 'invalid_epoch', 'NaN epoch is refused');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 0, endEpoch: 200 })) === 'invalid_epoch', 'epoch 0 is refused');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 1.5, endEpoch: 200 })) === 'invalid_epoch', 'a fractional epoch is refused');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 200, endEpoch: 100 })) === 'range_reversed', 'end before start is refused');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 100, endEpoch: 126 })) === 'lifetime_short', 'shorter than the minimum lifetime is refused (27 < 28)');
ok(planVotingLink(none, { publicKey: A, startEpoch: 100, endEpoch: 819 }).ok === true, 'the maximum lifetime (720) passes');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 100, endEpoch: 820 })) === 'lifetime_long', 'longer than the maximum lifetime is refused (721 > 720)');
const strict = { minLifetime: 112, maxLifetime: 360, maxKeys: 2 };
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 100, endEpoch: 200 }, strict)) === 'lifetime_short', 'the network limits are used when given (min 112)');
ok(err(planVotingLink(none, { publicKey: A, startEpoch: 100, endEpoch: 500 }, strict)) === 'lifetime_long', 'the network limits are used when given (max 360)');

// --- same link, overlap, count
ok(err(planVotingLink(one, { publicKey: A.toLowerCase(), startEpoch: 100, endEpoch: 200 })) === 'already_linked', 'the same key and range cannot be linked twice');
ok(err(planVotingLink(one, { publicKey: B, startEpoch: 100, endEpoch: 200 })) === 'overlap', 'another key over the same range is refused (ranges must not overlap)');
ok(err(planVotingLink(one, { publicKey: A, startEpoch: 150, endEpoch: 300 })) === 'overlap', 'a range that starts inside an existing one is refused');
ok(err(planVotingLink(one, { publicKey: B, startEpoch: 10, endEpoch: 100 })) === 'overlap', 'a range that ends on the first epoch of an existing one is refused');
ok(err(planVotingLink(one, { publicKey: B, startEpoch: 200, endEpoch: 300 })) === 'overlap', 'a range that starts on the last epoch of an existing one is refused');
ok(planVotingLink(one, { publicKey: B, startEpoch: 201, endEpoch: 300 }).ok === true, 'the range right after an existing one is fine');
ok(planVotingLink(one, { publicKey: B, startEpoch: 50, endEpoch: 99 }).ok === true, 'the range right before an existing one is fine');
const three = [{ publicKey: A, startEpoch: 100, endEpoch: 200 }, { publicKey: B, startEpoch: 201, endEpoch: 300 }, { publicKey: C, startEpoch: 301, endEpoch: 400 }];
ok(err(planVotingLink(three, { publicKey: D, startEpoch: 401, endEpoch: 500 })) === 'too_many', 'a 4th link is refused (3 at most by default)');
ok(err(planVotingLink(three.slice(0, 2), { publicKey: D, startEpoch: 401, endEpoch: 520 }, strict)) === 'too_many', 'the maximum comes from the network limits');
ok(checkVotingRange(none, 100, 200) === null && checkVotingRange(one, 150, 300) === 'overlap' && checkVotingRange(none, NaN, 5) === 'invalid_epoch', 'checkVotingRange needs no key');

// --- unlink
ok(json(planVotingUnlink(one, { publicKey: A.toLowerCase(), startEpoch: 100, endEpoch: 200 })) === json({ ok: true, links: [{ publicKey: A, startEpoch: 100, endEpoch: 200, link: false }] }), 'unlink names the key and the range that are linked');
ok(err(planVotingUnlink(one, { publicKey: A, startEpoch: 100, endEpoch: 201 })) === 'not_linked', 'unlink with another end epoch is refused (it must match exactly)');
ok(err(planVotingUnlink(one, { publicKey: A, startEpoch: 99, endEpoch: 200 })) === 'not_linked', 'unlink with another start epoch is refused');
ok(err(planVotingUnlink(one, { publicKey: B, startEpoch: 100, endEpoch: 200 })) === 'not_linked', 'unlink of another key is refused');
ok(err(planVotingUnlink(none, { publicKey: A, startEpoch: 100, endEpoch: 200 })) === 'not_linked', 'unlink of nothing is refused');
ok(json(planVotingUnlink(three, three[1])) === json({ ok: true, links: [{ ...three[1], link: false }] }), 'unlink one of several');

// --- re-check right before signing
const unlinkB = [{ ...three[1], link: false }];
ok(unlinksStillMatch(three, unlinkB), 'an unlink that still matches the chain passes');
ok(!unlinksStillMatch([three[0], three[2]], unlinkB), 'an unlink whose link is gone is caught');
ok(!unlinksStillMatch([three[0], { ...three[1], endEpoch: 301 }, three[2]], unlinkB), 'an unlink whose range changed is caught');
ok(unlinksStillMatch(none, [{ publicKey: A, startEpoch: 1, endEpoch: 50, link: true }]), 'a link needs nothing on the chain');

// --- list order / defaults
ok(json(sortVotingKeys([three[2], { ...three[0], publicKey: A.toLowerCase() }, three[1]]).map((x) => x.startEpoch)) === '[100,201,301]', 'listed by start epoch, keys in upper case');
ok(defaultVotingRange(null, none) === null, 'no suggestion without the current epoch');
ok(json(defaultVotingRange(1000, none)) === json({ startEpoch: 1002, endEpoch: 1721 }), 'suggested range: 2 epochs after now, the longest allowed');
ok(json(defaultVotingRange(1000, [{ publicKey: A, startEpoch: 1002, endEpoch: 1500 }])) === json({ startEpoch: 1501, endEpoch: 2220 }), 'suggested range starts after the last existing link');
ok(json(defaultVotingRange(1000, [{ publicKey: A, startEpoch: 5, endEpoch: 50 }])) === json({ startEpoch: 1002, endEpoch: 1721 }), 'an old link does not push the suggestion back');
const sug = defaultVotingRange(1000, none, DEFAULT_VOTING_LIMITS)!;
ok(planVotingLink(none, { publicKey: A, ...sug }).ok === true, 'the suggested range is accepted by the plan');

console.log(`${checks - fails}/${checks} passed`);
process.exit(fails === 0 ? 0 : 1);
