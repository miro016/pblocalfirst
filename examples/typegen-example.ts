/**
 * Compile-checked example of using pocketbase-localfirst with types generated
 * by pocketbase-typegen (https://github.com/patmood/pocketbase-typegen).
 *
 * Generate your types with e.g.:
 *   npx pocketbase-typegen --url https://your.pocketbase.io --email admin@example.com --password pass --out src/pocketbase-types.ts
 *
 * The block below mirrors what pocketbase-typegen emits.
 */
import PocketBase from 'pocketbase'
import { createLocalFirst } from '../src'

// ---- begin: shape emitted by pocketbase-typegen ---------------------------
export enum Collections {
  Posts = 'posts',
  Users = 'users',
}

export type IsoDateString = string
export type RecordIdString = string

export type BaseSystemFields<T = never> = {
  id: RecordIdString
  collectionId: string
  collectionName: Collections
  expand?: T
}

export type AuthSystemFields<T = never> = {
  email: string
  emailVisibility: boolean
  username: string
  verified: boolean
} & BaseSystemFields<T>

export type PostsRecord = {
  title?: string
  views?: number
  published?: boolean
  author?: RecordIdString
  tags?: string[]
  created?: IsoDateString
  updated?: IsoDateString
}

export type UsersRecord = {
  name?: string
  created?: IsoDateString
  updated?: IsoDateString
}

export type PostsResponse<Texpand = unknown> = Required<PostsRecord> & BaseSystemFields<Texpand>
export type UsersResponse<Texpand = unknown> = Required<UsersRecord> & AuthSystemFields<Texpand>

export type CollectionRecords = {
  posts: PostsRecord
  users: UsersRecord
}

export type CollectionResponses = {
  posts: PostsResponse
  users: UsersResponse
}
// ---- end: shape emitted by pocketbase-typegen -----------------------------

const pb = new PocketBase('https://your.pocketbase.io')

// Pass the generated CollectionResponses as the schema: collection names and
// record fields are now fully typed.
export const lf = createLocalFirst<CollectionResponses>({
  pb,
  collections: {
    posts: { cache: true, relations: { author: 'users' } },
    users: { cache: true },
  },
})

export async function demo(): Promise<void> {
  // list result items are PostsResponse
  const page = await lf.collection('posts').getList(1, 20, {
    filter: lf.filter('published = {:published} && views > {:min}', { published: true, min: 10 }),
    sort: '-created',
    expand: 'author',
  })
  const firstTitle: string = page.items[0].title
  void firstTitle

  // typed create/update bodies (PostsRecord)
  const created = await lf.collection('posts').create({ title: 'Hello', published: true } satisfies PostsRecord)
  await lf.collection('posts').update(created.id, { views: 1 })

  // reactive + live reads are typed too
  const published: PostsResponse[] = lf.collection('posts').list({ filter: 'published = true' })
  void published

  const live = lf.collection('posts').liveList({ sort: '-created' })
  const titles: string[] = live.value.map((p) => p.title)
  void titles
  live.dispose()

  // @ts-expect-error unknown collection names are rejected for typed schemas... (falls back to BaseRecord overload)
  const typo: never = lf.collection('post')
  void typo
}
