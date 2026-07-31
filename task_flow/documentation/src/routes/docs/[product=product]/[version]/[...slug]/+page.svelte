<script lang="ts">
  import {
    TableOfContents,
    Header,
    TabGroups,
    DocLayout,
    CategoryIndex,
    HotReloadIndicator,
    DevModeBadge,
    MdxHotReload,
    MdxContent,
    NotFoundContent,
    SearchHighlight,
    MobileDocLayout,
    mdxComponents,
  } from 'specra/components';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let allDocsCompat: any[] = $derived(data.allDocs);
  let previousDoc = $derived(data.previous ?? undefined);
  let nextDoc = $derived(data.next ?? undefined);
  let categoryTitle = $derived(data.categoryTitle ?? undefined);
  let categoryDescription = $derived(data.categoryDescription ?? undefined);
</script>

<svelte:head>
  <title>{data.title}</title>
  <meta name="description" content={data.description} />
  <meta property="og:title" content={data.title} />
  <meta property="og:description" content={data.description} />
  <meta property="og:url" content={data.ogUrl} />
  <meta property="og:site_name" content="Documentation Platform" />
  <meta property="og:type" content="article" />
  <meta property="og:locale" content="en_US" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={data.title} />
  <meta name="twitter:description" content={data.description} />
  <link rel="canonical" href={data.ogUrl} />
</svelte:head>

{#if !data.doc && data.isCategory}
  <!-- Category page without doc content -->
  <MobileDocLayout
    docs={allDocsCompat}
    version={data.version}
    product={data.product}
    config={data.config}
    activeTabGroup={data.categoryTabGroup}
  >
    {#snippet header()}
      <Header currentVersion={data.version} versions={data.versions} versionsMeta={data.versionsMeta} versionBanner={data.versionBanner} config={data.config} products={data.products} currentProduct={data.product}>
        {#snippet subheader()}
          {#if data.config.navigation?.tabGroups && data.config.navigation.tabGroups.length > 0}
            <TabGroups
              tabGroups={data.config.navigation.tabGroups}
              activeTabId={data.categoryTabGroup}
              docs={allDocsCompat}
              version={data.version}
              product={data.product}
              flush={data.config.navigation?.sidebarStyle === 'flush'}
            />
          {/if}
        {/snippet}
      </Header>
    {/snippet}
    <CategoryIndex
      categoryPath={data.slug}
      version={data.version}
      product={data.product}
      allDocs={allDocsCompat}
      title={categoryTitle}
      description={categoryDescription}
      config={data.config}
    />
  </MobileDocLayout>
  <MdxHotReload />
  <HotReloadIndicator />
  <DevModeBadge />
{:else if data.isNotFound}
  <!-- Not found -->
  <MobileDocLayout
    docs={allDocsCompat}
    version={data.version}
    product={data.product}
    config={data.config}
  >
    {#snippet header()}
      <Header currentVersion={data.version} versions={data.versions} versionsMeta={data.versionsMeta} versionBanner={data.versionBanner} config={data.config} products={data.products} currentProduct={data.product}>
        {#snippet subheader()}
          {#if data.config.navigation?.tabGroups && data.config.navigation.tabGroups.length > 0}
            <TabGroups
              tabGroups={data.config.navigation.tabGroups}
              activeTabId={data.categoryTabGroup}
              docs={allDocsCompat}
              version={data.version}
              product={data.product}
              flush={data.config.navigation?.sidebarStyle === 'flush'}
            />
          {/if}
        {/snippet}
      </Header>
    {/snippet}
    <NotFoundContent version={data.version} />
  </MobileDocLayout>
  <MdxHotReload />
  <HotReloadIndicator />
  <DevModeBadge />
{:else if data.doc}
  <!-- Normal doc or category with doc content -->
  <MobileDocLayout
    docs={allDocsCompat}
    version={data.version}
    product={data.product}
    config={data.config}
    activeTabGroup={data.categoryTabGroup}
  >
    {#snippet header()}
      <Header currentVersion={data.version} versions={data.versions} versionsMeta={data.versionsMeta} versionBanner={data.versionBanner} config={data.config} products={data.products} currentProduct={data.product}>
        {#snippet subheader()}
          {#if data.config.navigation?.tabGroups && data.config.navigation.tabGroups.length > 0}
            <TabGroups
              tabGroups={data.config.navigation.tabGroups}
              activeTabId={data.categoryTabGroup}
              docs={allDocsCompat}
              version={data.version}
              product={data.product}
              flush={data.config.navigation?.sidebarStyle === 'flush'}
            />
          {/if}
        {/snippet}
      </Header>
    {/snippet}
    {#snippet toc()}
      {#if !data.isCategory}
        <TableOfContents items={data.toc} config={data.config} />
      {/if}
    {/snippet}

    {#if data.isCategory}
      {#snippet categoryContent()}
        {#if data.doc?.contentNodes}
          <MdxContent nodes={data.doc.contentNodes} components={mdxComponents} />
        {:else if data.doc?.content}
          {@html data.doc.content}
        {/if}
      {/snippet}
      <CategoryIndex
        categoryPath={data.slug}
        version={data.version}
        allDocs={allDocsCompat}
        title={data.doc.meta.title}
        description={data.doc.meta.description}
        content={categoryContent}
        config={data.config}
      />
    {:else}
      <SearchHighlight />
      <DocLayout
        meta={data.doc.meta}
        previousDoc={previousDoc}
        nextDoc={nextDoc}
        version={data.version}
        slug={data.slug}
        product={data.product}
        config={data.config}
      >
        {#if data.doc.contentNodes}
          <MdxContent nodes={data.doc.contentNodes} components={mdxComponents} />
        {:else}
          {@html data.doc.content}
        {/if}
      </DocLayout>
    {/if}
  </MobileDocLayout>
  <MdxHotReload />
  <HotReloadIndicator />
  <DevModeBadge />
{/if}
