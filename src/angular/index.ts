import { InjectionToken, inject, makeEnvironmentProviders, signal, type EnvironmentProviders } from '@angular/core'
import { createLocalFirst, LocalFirstClient } from '../client'
import type { ReactivityAdapter } from '../reactivity'
import type { LocalFirstConfig, SchemaDef } from '../types'

/**
 * Angular signals integration. Every reactive read
 * (`collection.list()`, `collection.one(id)`, `client.status`, `liveQuery.value`)
 * reads a hidden signal, so Angular `computed`/`effect`/templates re-run
 * automatically when local data changes:
 *
 * ```ts
 * @Component({ template: `@for (post of posts(); track post.id) { ... }` })
 * class PostsComponent {
 *   private lf = injectLocalFirst<CollectionResponses>()
 *   posts = computed(() => this.lf.collection('posts').list({ filter: 'published = true', sort: '-created' }))
 * }
 * ```
 */
export const angularReactivity: ReactivityAdapter = {
  create() {
    const version = signal(0)
    return {
      depend: () => {
        version()
      },
      notify: () => {
        version.update((v) => v + 1)
      },
    }
  },
}

export const LOCAL_FIRST = new InjectionToken<LocalFirstClient<any>>('pocketbase-localfirst client')

/**
 * Register the client in the Angular DI container:
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideLocalFirst(() => ({ pb, collections: { ... } }))],
 * })
 * ```
 * The Angular signals reactivity adapter is applied automatically.
 */
export function provideLocalFirst<S extends SchemaDef>(
  config: LocalFirstConfig<S> | (() => LocalFirstConfig<S>),
): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: LOCAL_FIRST,
      useFactory: () => {
        const resolved = typeof config === 'function' ? config() : config
        return createLocalFirst<S>({ reactivity: angularReactivity, ...resolved })
      },
    },
  ])
}

/** Inject the client with your generated schema types: `injectLocalFirst<CollectionResponses>()`. */
export function injectLocalFirst<S extends SchemaDef = SchemaDef>(): LocalFirstClient<S> {
  return inject(LOCAL_FIRST) as LocalFirstClient<S>
}
