# Correct an artist's MBID

Use this when an artist is registered with the MusicBrainz ID (MBID) of a
different person who has the same name. The signs: the artist's name, images or
`activity_ended` do not match the artist (a group that ended in 2002 for a band
playing next month), the daily catalog refresh keeps pulling the wrong values,
or concert discovery skips the artist because the namesake's activity ended.

Last.fm's lookup by name returns the namesake's MBID, and a search registers
whatever MBID it gets, so the mistake comes back with every search of that
name. The command below fixes the artist and also remembers the wrong MBID
(`other_mbids`), so a later search that returns it finds the corrected artist
instead of registering a second one.

## 1. Choose the right MBID

Open the artist's MusicBrainz page for the MBID it has now and for each other
artist of the same name
(`https://musicbrainz.org/search?type=artist&query=<name>`). Compare country,
life span, type and disambiguation, and the artist's concerts and links
(official site, Twitter) with the right person. The MBID is the UUID at the end
of the page's address. Do not take the MBID from Last.fm: it is the source of
the mistake.

Check that no other row holds it, read-only (personal login:
[cloud-sql-access.md](cloud-sql-access.md)):

```sql
SELECT id, name, mbid, other_mbids FROM artists
WHERE mbid = '<mbid>' OR other_mbids @> ARRAY['<mbid>'];
```

A row means the right artist is already registered under another id (for
example a duplicate registered by a search after an earlier hand fix). The
command refuses with `AlreadyExists`; resolve that duplicate first (it is not
merged for you).

## 2. Run the command

Get prod credentials first: [prod-cluster-credentials.md](prod-cluster-credentials.md).
The command runs in the workflow worker's Pod, as its database identity, like
the `workflow` commands of [workflow-needs-admin.md](workflow-needs-admin.md).

```bash
kubectl exec deploy/workflow-worker -n backend -- \
  /worker artist correct-mbid <artist_id> <mbid>
```

It checks that MusicBrainz knows the MBID (a typo fails here and stores
nothing), stores the MBID MusicBrainz returns for it (the surviving MBID when
the one you gave was merged), keeps the replaced MBID in `other_mbids`, and
reads the artist again, so the name and `activity_ended` become the right
person's. It prints the artist as JSON on stdout; check that `name` and
`activity_ended` are what you expect.

The command clears what was read from the namesake and nothing else:

| Cleared | Comes back |
|---|---|
| images (`fanart`, `fanart_sync_time`) | the next artist image sync |
| official site and `official_site_check_time` | the next official site refresh, for a followed artist, from the right MBID |
| `activity_ended` | at once, from the catalog read |

Concerts already found for the artist stay. Look at them
(`SELECT ... FROM concert_artists ...`) and handle a wrong one by hand.

If the command fails with `Unavailable` after the MBID was stored, run it again
with the same MBID: it changes nothing stored and reads the catalog again.

## 3. Record a hand-fixed artist's old MBID

An artist whose MBID was changed directly in the database has the namesake's
MBID in no `other_mbids`. After step 1 shows that no row holds the namesake's
MBID, run the command to the namesake's MBID and then back to the right one: the
first run records the right MBID as an other MBID, the second makes it the
artist's MBID again and leaves the namesake's recorded.

## 4. Check

Read-only, with the personal login:

```sql
SELECT id, name, mbid, other_mbids, activity_ended FROM artists WHERE id = '<artist_id>';
SELECT count(*) FROM artists WHERE mbid = '<old_mbid>' OR other_mbids @> ARRAY['<old_mbid>'];  -- 1
```

## Background

OpenSpec change `correct-artist-mbid` (capabilities
`components/entity/artist/update-mbid` and
`components/usecase/artist/correct-mbid`); backend issue
`liverty-music/backend#920`.
