import { KeyObject } from 'node:crypto';
import { JsonValue } from '@bufbuild/protobuf';
import { RouterConfig } from '@wundergraph/cosmo-connect/dist/node/v1/node_pb';
import { joinLabel, normalizeURL } from '@wundergraph/cosmo-shared';
import { SQL, and, asc, desc, eq, exists, gt, inArray, lt, not, notExists, notInArray, sql } from 'drizzle-orm';
import { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { SignJWT, generateKeyPair, importPKCS8 } from 'jose';
import * as schema from '../../db/schema.js';
import {
  federatedGraphs,
  graphApiTokens,
  graphCompositions,
  graphRequestKeys,
  schemaVersion,
  schemaVersionChangeAction,
  targetLabelMatchers,
  targets,
  users,
} from '../../db/schema.js';
import {
  DateRange,
  FederatedGraphChangelogDTO,
  FederatedGraphDTO,
  GraphApiKeyDTO,
  Label,
  ListFilterOptions,
  RouterRequestKeysDTO,
} from '../../types/index.js';
import { BlobStorage } from '../blobstorage/index.js';
import { Composer } from '../composition/composer.js';
import { SchemaDiff } from '../composition/schemaCheck.js';
import { normalizeLabelMatchers, normalizeLabels } from '../util.js';
import { GraphCompositionRepository } from './GraphCompositionRepository.js';
import { NamespaceRepository } from './NamespaceRepository.js';
import { SubgraphRepository } from './SubgraphRepository.js';
import { TargetRepository } from './TargetRepository.js';
import { UserRepository } from './UserRepository.js';

export interface FederatedGraphConfig {
  trafficCheckDays: number;
}

/**
 * Repository for managing V1 federated graphs.
 */
export class FederatedGraphRepository {
  constructor(
    private db: PostgresJsDatabase<typeof schema>,
    private organizationId: string,
  ) {}

  public create(data: {
    name: string;
    namespace: string;
    namespaceId: string;
    routingUrl: string;
    labelMatchers: string[];
    createdBy: string;
    readme?: string;
  }): Promise<FederatedGraphDTO | undefined> {
    return this.db.transaction(async (tx) => {
      const subgraphRepo = new SubgraphRepository(tx, this.organizationId);

      const labelMatchers = normalizeLabelMatchers(data.labelMatchers);
      const routingUrl = normalizeURL(data.routingUrl);

      const insertedTarget = await tx
        .insert(targets)
        .values({
          organizationId: this.organizationId,
          name: data.name,
          type: 'federated',
          createdBy: data.createdBy,
          readme: data.readme,
          namespaceId: data.namespaceId,
        })
        .returning()
        .execute();

      const insertedGraph = await tx
        .insert(federatedGraphs)
        .values({
          targetId: insertedTarget[0].id,
          routingUrl,
        })
        .returning()
        .execute();

      if (labelMatchers.length > 0) {
        await tx
          .insert(schema.targetLabelMatchers)
          .values(
            labelMatchers.map((s) => ({
              targetId: insertedTarget[0].id,
              labelMatcher: s.split(','),
            })),
          )
          .execute();
      }

      const subgraphs = await subgraphRepo.byGraphLabelMatchers({
        labelMatchers: data.labelMatchers,
        namespaceId: data.namespaceId,
      });

      if (subgraphs.length > 0) {
        await tx
          .insert(schema.subgraphsToFederatedGraph)
          .values(
            subgraphs.map((sg) => ({
              subgraphId: sg.id,
              federatedGraphId: insertedGraph[0].id,
            })),
          )
          .execute();
      }

      return {
        id: insertedGraph[0].id,
        targetId: insertedTarget[0].id,
        name: insertedTarget[0].name,
        isComposable: false,
        routingUrl: insertedGraph[0].routingUrl,
        compositionErrors: '',
        lastUpdatedAt: '',
        labelMatchers: data.labelMatchers,
        subgraphsCount: subgraphs.length,
        namespace: data.namespace,
        namespaceId: data.namespaceId,
      };
    });
  }

  public update(data: {
    targetId: string;
    routingUrl: string;
    labelMatchers: string[];
    updatedBy: string;
    readme?: string;
    blobStorage: BlobStorage;
    namespaceId: string;
    unsetLabelMatchers: boolean;
  }) {
    const routingUrl = normalizeURL(data.routingUrl);

    return this.db.transaction(async (tx) => {
      const fedGraphRepo = new FederatedGraphRepository(tx, this.organizationId);
      const subgraphRepo = new SubgraphRepository(tx, this.organizationId);
      const targetRepo = new TargetRepository(tx, this.organizationId);
      const compositionRepo = new GraphCompositionRepository(tx);

      const federatedGraph = await fedGraphRepo.byTargetId(data.targetId);
      if (!federatedGraph) {
        throw new Error(`Federated graph not found`);
      }

      // update routing URL when changed
      if (routingUrl && federatedGraph.routingUrl !== routingUrl) {
        await tx.update(federatedGraphs).set({ routingUrl }).where(eq(federatedGraphs.id, federatedGraph.id)).execute();
      }

      // update the readme of the fed graph
      if (data.readme) {
        await targetRepo.updateReadmeOfTarget({ id: data.targetId, readme: data.readme });
      }

      // update label matchers
      if (data.labelMatchers.length > 0 || data.unsetLabelMatchers) {
        const labelMatchers = data.unsetLabelMatchers ? [] : normalizeLabelMatchers(data.labelMatchers);

        await tx
          .delete(schema.targetLabelMatchers)
          .where(eq(schema.targetLabelMatchers.targetId, federatedGraph.targetId));

        if (labelMatchers.length > 0) {
          await tx
            .insert(schema.targetLabelMatchers)
            .values(
              labelMatchers.map((labelMatcher) => ({
                targetId: federatedGraph.targetId,
                labelMatcher: labelMatcher.split(','),
              })),
            )
            .execute();
        }

        const subgraphs = await subgraphRepo.byGraphLabelMatchers({ labelMatchers, namespaceId: data.namespaceId });

        let deleteCondition: SQL<unknown> | undefined = eq(
          schema.subgraphsToFederatedGraph.federatedGraphId,
          federatedGraph.id,
        );

        // we do this conditionally because notInArray cannot take empty value
        if (subgraphs.length > 0) {
          deleteCondition = and(
            deleteCondition,
            notInArray(
              schema.subgraphsToFederatedGraph.subgraphId,
              subgraphs.map((subgraph) => subgraph.id),
            ),
          );
        }

        await tx.delete(schema.subgraphsToFederatedGraph).where(deleteCondition);

        if (subgraphs.length > 0) {
          await tx
            .insert(schema.subgraphsToFederatedGraph)
            .values(
              subgraphs.map((sg) => ({
                subgraphId: sg.id,
                federatedGraphId: federatedGraph.id,
              })),
            )
            .onConflictDoNothing()
            .execute();
        }

        const composer = new Composer(fedGraphRepo, subgraphRepo, compositionRepo);
        const composedGraph = await composer.composeFederatedGraph(federatedGraph);

        await composer.deployComposition({
          composedGraph,
          composedBy: data.updatedBy,
          blobStorage: data.blobStorage,
          organizationId: this.organizationId,
        });

        return composedGraph.errors;
      }
    });
  }

  public updateReadme({ targetId, readme }: { targetId: string; readme: string }) {
    return this.db
      .update(targets)
      .set({ readme })
      .where(and(eq(targets.id, targetId), eq(schema.targets.organizationId, this.organizationId)));
  }

  public move(
    data: { targetId: string; newNamespaceId: string; updatedBy: string; federatedGraph: FederatedGraphDTO },
    blobStorage: BlobStorage,
  ) {
    return this.db.transaction(async (tx) => {
      const namespaceRepo = new NamespaceRepository(tx, this.organizationId);
      const fedGraphRepo = new FederatedGraphRepository(tx, this.organizationId);
      const subgraphRepo = new SubgraphRepository(tx, this.organizationId);
      const compositionRepo = new GraphCompositionRepository(tx);

      await tx.update(targets).set({ namespaceId: data.newNamespaceId }).where(eq(targets.id, data.targetId));

      // Delete all mappings because we will deal with new subgraphs in new namespace
      await tx
        .delete(schema.subgraphsToFederatedGraph)
        .where(eq(schema.subgraphsToFederatedGraph.federatedGraphId, data.federatedGraph.id));

      const newNamespaceSubgraphs = await subgraphRepo.byGraphLabelMatchers({
        labelMatchers: data.federatedGraph.labelMatchers,
        namespaceId: data.newNamespaceId,
      });

      // insert new mappings
      if (newNamespaceSubgraphs.length > 0) {
        await tx
          .insert(schema.subgraphsToFederatedGraph)
          .values(
            newNamespaceSubgraphs.map((sg) => ({
              subgraphId: sg.id,
              federatedGraphId: data.federatedGraph.id,
            })),
          )
          .onConflictDoNothing()
          .execute();
      }

      const composer = new Composer(fedGraphRepo, subgraphRepo, compositionRepo);
      const composedGraph = await composer.composeFederatedGraph(data.federatedGraph);

      await composer.deployComposition({
        composedGraph,
        composedBy: data.updatedBy,
        blobStorage,
        organizationId: this.organizationId,
      });

      return composedGraph.errors;
    });
  }

  public async list(opts: ListFilterOptions): Promise<FederatedGraphDTO[]> {
    const conditions: SQL<unknown>[] = [
      eq(schema.targets.type, 'federated'),
      eq(schema.targets.organizationId, this.organizationId),
    ];

    if (opts.namespaceId) {
      conditions.push(eq(schema.targets.namespaceId, opts.namespaceId));
    }

    const targets = await this.db.query.targets.findMany({
      where: and(...conditions),
      limit: opts.limit,
      offset: opts.offset,
      orderBy: asc(schema.targets.namespaceId),
    });

    const federatedGraphs: FederatedGraphDTO[] = [];

    for (const target of targets) {
      const fg = await this.byTargetId(target.id);
      if (fg === undefined) {
        throw new Error(`FederatedGraph ${target.name} not found`);
      }
      federatedGraphs.push(fg);
    }

    return federatedGraphs;
  }

  // Returns count of federated graphs across all namespaces
  public async count(): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`cast(count(${targets.id}) as int)` })
      .from(schema.targets)
      .where(and(eq(schema.targets.type, 'federated'), eq(schema.targets.organizationId, this.organizationId)))
      .execute();

    return result[0]?.count || 0;
  }

  private async getFederatedGraph(conditions: SQL<unknown>[]): Promise<FederatedGraphDTO | undefined> {
    const resp = await this.db
      .select({
        name: schema.targets.name,
        labelMatchers: schema.targets.labels,
        createdBy: schema.targets.createdBy,
        readme: schema.targets.readme,
        id: schema.federatedGraphs.id,
        routingUrl: schema.federatedGraphs.routingUrl,
        targetId: schema.federatedGraphs.targetId,
        composedSchemaVersionId: schema.federatedGraphs.composedSchemaVersionId,
        namespaceId: schema.namespaces.id,
        namespaceName: schema.namespaces.name,
      })
      .from(targets)
      .where(and(...conditions))
      .innerJoin(schema.federatedGraphs, eq(targets.id, schema.federatedGraphs.targetId))
      .innerJoin(schema.namespaces, eq(schema.namespaces.id, schema.targets.namespaceId));

    if (resp.length === 0) {
      return undefined;
    }

    const latestVersion = await this.db
      .select({
        id: schemaVersion.id,
        isComposable: graphCompositions.isComposable,
        compositionErrors: graphCompositions.compositionErrors,
        createdAt: schemaVersion.createdAt,
      })
      .from(schemaVersion)
      .innerJoin(graphCompositions, eq(schemaVersion.id, graphCompositions.schemaVersionId))
      .where(eq(schemaVersion.targetId, resp[0].targetId))
      .orderBy(desc(schemaVersion.createdAt))
      .limit(1)
      .execute();

    const labelMatchers = await this.db.query.targetLabelMatchers.findMany({
      where: eq(schema.targetLabelMatchers.targetId, resp[0].targetId),
    });

    const subgraphs = await this.db.query.subgraphsToFederatedGraph.findMany({
      where: eq(schema.subgraphsToFederatedGraph.federatedGraphId, resp[0].id),
    });

    // Composed schema version is not set when the federated graph was not composed.
    return {
      id: resp[0].id,
      name: resp[0].name,
      routingUrl: resp[0].routingUrl,
      isComposable: latestVersion?.[0]?.isComposable ?? false,
      compositionErrors: latestVersion?.[0]?.compositionErrors ?? '',
      lastUpdatedAt: latestVersion?.[0]?.createdAt?.toISOString() ?? '',
      targetId: resp[0].targetId,
      schemaVersionId: resp[0].composedSchemaVersionId ?? undefined,
      subgraphsCount: subgraphs.length ?? 0,
      labelMatchers: labelMatchers.map((s) => s.labelMatcher.join(',')),
      creatorUserId: resp[0].createdBy || undefined,
      readme: resp[0].readme || undefined,
      namespace: resp[0].namespaceName,
      namespaceId: resp[0].namespaceId,
    };
  }

  public byTargetId(targetId: string): Promise<FederatedGraphDTO | undefined> {
    return this.getFederatedGraph([
      eq(schema.targets.id, targetId),
      eq(schema.targets.organizationId, this.organizationId),
      eq(schema.targets.type, 'federated'),
    ]);
  }

  public async byId(id: string): Promise<FederatedGraphDTO | undefined> {
    const res = await this.db.query.federatedGraphs.findFirst({
      where: eq(schema.federatedGraphs.id, id),
    });

    if (!res) {
      return undefined;
    }

    return this.byTargetId(res.targetId);
  }

  public async exists(name: string, namespace: string): Promise<boolean> {
    const graphs = await this.db
      .select()
      .from(targets)
      .innerJoin(schema.namespaces, and(eq(schema.namespaces.id, targets.namespaceId)))
      .where(
        and(
          eq(schema.targets.name, name),
          eq(schema.targets.organizationId, this.organizationId),
          eq(schema.targets.type, 'federated'),
          eq(schema.namespaces.name, namespace),
        ),
      );

    return graphs.length === 1;
  }

  public byName(name: string, namespace: string): Promise<FederatedGraphDTO | undefined> {
    return this.getFederatedGraph([
      eq(schema.targets.name, name),
      eq(schema.targets.organizationId, this.organizationId),
      eq(schema.targets.type, 'federated'),
      eq(schema.namespaces.name, namespace),
    ]);
  }

  /**
   * bySubgraphLabels returns federated graphs whose label matchers satisfy the given subgraph labels.
   */
  public async bySubgraphLabels(data: { labels: Label[]; namespaceId: string }): Promise<FederatedGraphDTO[]> {
    const uniqueLabels = normalizeLabels(data.labels);

    const graphs = await this.db
      .select({
        id: targets.id,
        name: targets.name,
      })
      .from(targets)
      .where(
        and(
          eq(targets.organizationId, this.organizationId),
          eq(targets.type, 'federated'),
          eq(targets.namespaceId, data.namespaceId),
          // In case labels are empty only compose with graphs whose label matchers are also empty.
          // This is a negative lookup. We check if the graph has label matchers and then
          // If there is a label matchers of a federated graph that does not match the given subgraph labels.
          // If all label matchers match, then the federated graph will be part of the result.
          data.labels.length > 0
            ? and(
                exists(this.db.select().from(targetLabelMatchers).where(eq(targetLabelMatchers.targetId, targets.id))),
                notExists(
                  this.db
                    .select()
                    .from(targetLabelMatchers)
                    .where(
                      and(
                        eq(targetLabelMatchers.targetId, targets.id),
                        not(
                          // We created a GIN index on the label_matcher column, so we can look up
                          // very quickly if the label matcher matches the given subgraph labels.
                          sql.raw(
                            `${targetLabelMatchers.labelMatcher.name} && ARRAY[${uniqueLabels.map(
                              (ul) => "'" + joinLabel(ul) + "'",
                            )}]`,
                          ),
                        ),
                      ),
                    ),
                ),
              )
            : notExists(this.db.select().from(targetLabelMatchers).where(eq(targetLabelMatchers.targetId, targets.id))),
        ),
      )
      .innerJoin(federatedGraphs, eq(federatedGraphs.targetId, targets.id))
      .leftJoin(schemaVersion, eq(schemaVersion.id, federatedGraphs.composedSchemaVersionId))
      .orderBy(asc(targets.createdAt), asc(schemaVersion.createdAt))
      .execute();

    const graphsDTOs: FederatedGraphDTO[] = [];

    for (const target of graphs) {
      const fg = await this.byTargetId(target.id);
      if (fg === undefined) {
        throw new Error(`FederatedGraph ${target.name} not found`);
      }

      graphsDTOs.push(fg);
    }

    return graphsDTOs;
  }

  /**
   * addSchemaVersion adds a new schema version to the given federated graph. When
   * the schema version is not composable the errors are stored in the compositionErrors
   * but the composedSchemaVersionId is not updated.
   */
  public addSchemaVersion({
    targetId,
    composedSDL,
    compositionErrors,
    routerConfig,
    subgraphSchemaVersionIds,
    composedBy,
    routerConfigPath,
    schemaVersionId,
  }: {
    targetId: string;
    schemaVersionId: string;
    composedSDL?: string;
    compositionErrors?: Error[];
    routerConfig?: JsonValue;
    subgraphSchemaVersionIds: string[];
    composedBy: string;
    routerConfigPath: string | null;
  }) {
    return this.db.transaction<FederatedGraphDTO | undefined>(async (tx) => {
      const fedGraphRepo = new FederatedGraphRepository(tx, this.organizationId);
      const compositionRepo = new GraphCompositionRepository(tx);
      const fedGraph = await fedGraphRepo.byTargetId(targetId);
      if (fedGraph === undefined) {
        return undefined;
      }

      let compositionErrorString = '';

      if (compositionErrors && compositionErrors.length > 0) {
        compositionErrorString = compositionErrors.map((e) => e.toString()).join('\n');
      }

      const insertedVersion = await tx
        .insert(schemaVersion)
        .values({
          id: schemaVersionId,
          targetId: fedGraph.targetId,
          schemaSDL: composedSDL,
        })
        .returning({
          insertedId: schemaVersion.id,
        });

      // Always update the federated schema after composing, even if the schema is not composable.
      // That allows us to display the latest schema version in the UI. The router will only fetch
      // the latest composable schema version.
      await tx
        .update(federatedGraphs)
        .set({
          composedSchemaVersionId: insertedVersion[0].insertedId,
          routerConfigPath,
        })
        .where(eq(federatedGraphs.id, fedGraph.id));

      // adding the composition entry and the relation between fedGraph schema version and subgraph schema version
      await compositionRepo.addComposition({
        fedGraphSchemaVersionId: insertedVersion[0].insertedId,
        subgraphSchemaVersionIds,
        compositionErrorString,
        routerConfig,
        composedBy,
      });

      return {
        id: fedGraph.id,
        targetId: fedGraph.targetId,
        name: fedGraph.name,
        labelMatchers: fedGraph.labelMatchers,
        compositionErrors: compositionErrorString,
        isComposable: fedGraph.isComposable,
        lastUpdatedAt: fedGraph.lastUpdatedAt,
        routingUrl: fedGraph.routingUrl,
        subgraphsCount: fedGraph.subgraphsCount,
        composedSchemaVersionId: insertedVersion[0].insertedId,
        namespace: fedGraph.namespace,
        namespaceId: fedGraph.namespaceId,
      };
    });
  }

  public async isLatestValidSchemaVersion(targetId: string, schemaVersionId: string): Promise<boolean> {
    const latestValidVersion = await this.db
      .select({
        id: schemaVersion.id,
      })
      .from(schemaVersion)
      .innerJoin(graphCompositions, eq(schemaVersion.id, graphCompositions.schemaVersionId))
      .where(and(eq(schemaVersion.targetId, targetId), eq(graphCompositions.isComposable, true)))
      .orderBy(desc(schemaVersion.createdAt))
      .limit(1)
      .execute();

    return latestValidVersion?.[0]?.id === schemaVersionId;
  }

  public async isLatestSchemaVersion(targetId: string, schemaVersionId: string): Promise<boolean> {
    const latestValidVersion = await this.db
      .select({
        id: schemaVersion.id,
      })
      .from(schemaVersion)
      .innerJoin(graphCompositions, eq(schemaVersion.id, graphCompositions.schemaVersionId))
      .where(eq(schemaVersion.targetId, targetId))
      .orderBy(desc(schemaVersion.createdAt))
      .limit(1)
      .execute();

    return latestValidVersion?.[0]?.id === schemaVersionId;
  }

  public async getLatestValidRouterConfig(targetId: string): Promise<
    | {
        config: RouterConfig;
        schemaVersionId: string;
      }
    | undefined
  > {
    const latestValidVersion = await this.db
      .select({
        id: schemaVersion.id,
        routerConfig: graphCompositions.routerConfig,
      })
      .from(schemaVersion)
      .innerJoin(graphCompositions, eq(schemaVersion.id, graphCompositions.schemaVersionId))
      .where(and(eq(schemaVersion.targetId, targetId), eq(graphCompositions.isComposable, true)))
      .orderBy(desc(schemaVersion.createdAt))
      .limit(1)
      .execute();

    if (!latestValidVersion || latestValidVersion.length === 0) {
      return undefined;
    }

    return {
      config: RouterConfig.fromJson(latestValidVersion[0].routerConfig as JsonValue),
      schemaVersionId: latestValidVersion[0].id,
    };
  }

  // returns the latest valid schema version of a federated graph
  public async getLatestValidSchemaVersion(data: { targetId: string }) {
    const latestValidVersion = await this.db
      .select({
        name: targets.name,
        schemaSDL: schemaVersion.schemaSDL,
        schemaVersionId: schemaVersion.id,
      })
      .from(targets)
      .innerJoin(federatedGraphs, eq(federatedGraphs.targetId, targets.id))
      .innerJoin(schemaVersion, eq(schema.schemaVersion.targetId, targets.id))
      .innerJoin(graphCompositions, eq(schemaVersion.id, graphCompositions.schemaVersionId))
      .where(
        and(
          eq(targets.type, 'federated'),
          eq(targets.organizationId, this.organizationId),
          eq(targets.id, data.targetId),
          eq(graphCompositions.isComposable, true),
        ),
      )
      .orderBy(desc(graphCompositions.createdAt))
      .limit(1)
      .execute();

    if (latestValidVersion.length === 0) {
      return undefined;
    }

    return {
      schema: latestValidVersion[0].schemaSDL,
      schemaVersionId: latestValidVersion[0].schemaVersionId,
    };
  }

  public async getSdlBasedOnSchemaVersion({
    targetId,
    schemaVersionId,
  }: {
    targetId: string;
    schemaVersionId: string;
  }) {
    const version = await this.db
      .select({
        name: targets.name,
        schemaSDL: schemaVersion.schemaSDL,
        schemaVersionId: schemaVersion.id,
      })
      .from(targets)
      .innerJoin(schemaVersion, eq(schema.schemaVersion.targetId, targets.id))
      .where(
        and(
          eq(targets.organizationId, this.organizationId),
          eq(targets.id, targetId),
          eq(schemaVersion.id, schemaVersionId),
        ),
      )
      .execute();

    if (version.length === 0) {
      return undefined;
    }

    return version[0].schemaSDL;
  }

  public createFederatedGraphChangelog(data: { schemaVersionID: string; changes: SchemaDiff[] }) {
    return this.db
      .insert(schemaVersionChangeAction)
      .values(
        data.changes.map((change) => ({
          schemaVersionId: data.schemaVersionID,
          changeType: change.changeType,
          changeMessage: change.message,
          path: change.path,
        })),
      )
      .execute();
  }

  public fetchFederatedGraphChangelog(
    targetId: string,
    pagination: {
      limit: number;
      offset: number;
    },
    dateRange: DateRange,
  ): Promise<{ federatedGraphChangelog: FederatedGraphChangelogDTO[]; hasNextPage: boolean } | undefined> {
    return this.db.transaction<
      { federatedGraphChangelog: FederatedGraphChangelogDTO[]; hasNextPage: boolean } | undefined
    >(async (tx) => {
      const federatedGraphChangelog: FederatedGraphChangelogDTO[] = [];

      const { offset, limit } = pagination;
      const { start, end } = dateRange;

      // Get all schema version ids which have changelogs
      const schemaVersionIds = (
        await tx
          .select({
            id: schemaVersion.id,
          })
          .from(schemaVersion)
          .where(
            and(
              eq(schemaVersion.targetId, targetId),
              gt(schemaVersion.createdAt, new Date(start)),
              lt(schemaVersion.createdAt, new Date(end)),
            ),
          )
          .innerJoin(schemaVersionChangeAction, eq(schemaVersionChangeAction.schemaVersionId, schemaVersion.id))
          .orderBy(desc(schemaVersion.createdAt))
          .groupBy(schemaVersion.id)
          .offset(offset)
          .limit(limit)
      ).map((sv) => sv.id);

      if (schemaVersionIds.length === 0) {
        return { federatedGraphChangelog, hasNextPage: false };
      }

      const schemaVersions = await tx.query.schemaVersion.findMany({
        where: (sv) => inArray(sv.id, schemaVersionIds),
        columns: {
          id: true,
          createdAt: true,
        },
        with: {
          changes: {
            orderBy: desc(schemaVersionChangeAction.createdAt),
          },
        },
        orderBy: desc(schemaVersion.createdAt),
      });

      const entriesAfterCurrentPage = await tx
        .select({ id: schemaVersion.id })
        .from(schemaVersion)
        .innerJoin(schemaVersionChangeAction, eq(schemaVersionChangeAction.schemaVersionId, schemaVersion.id))
        .where(
          and(
            eq(schemaVersion.targetId, targetId),
            gt(schemaVersion.createdAt, new Date(start)),
            lt(schemaVersion.createdAt, new Date(end)),
          ),
        )
        .orderBy(desc(schemaVersion.createdAt))
        .groupBy(schemaVersion.id)
        .offset(offset + schemaVersions.length)
        .limit(limit);

      for (const sv of schemaVersions) {
        federatedGraphChangelog.push({
          schemaVersionId: sv.id,
          createdAt: sv.createdAt.toString(),
          changelogs: sv.changes.map((c) => ({
            id: c.id,
            path: c.path || '',
            changeType: c.changeType,
            changeMessage: c.changeMessage,
            createdAt: c.createdAt.toString(),
          })),
        });
      }

      return { federatedGraphChangelog, hasNextPage: entriesAfterCurrentPage.length > 0 };
    });
  }

  public async fetchLatestFederatedGraphChangelog(
    federatedGraphId: string,
  ): Promise<FederatedGraphChangelogDTO | undefined> {
    const federatedGraph = await this.db
      .select({ schemaVersionId: federatedGraphs.composedSchemaVersionId })
      .from(federatedGraphs)
      .innerJoin(targets, eq(targets.id, federatedGraphs.targetId))
      .where(and(eq(federatedGraphs.id, federatedGraphId), eq(targets.organizationId, this.organizationId)));

    if (federatedGraph.length === 0) {
      return undefined;
    }

    if (!federatedGraph[0].schemaVersionId) {
      return undefined;
    }

    const changelogs = await this.fetchChangelogByVersion({ schemaVersionId: federatedGraph[0].schemaVersionId });

    if (changelogs.length === 0) {
      return undefined;
    }

    return {
      schemaVersionId: federatedGraph[0].schemaVersionId,
      createdAt: changelogs[0].createdAt.toString(),
      changelogs: changelogs.map((c) => ({
        id: c.id,
        path: c.path || '',
        changeType: c.changeType,
        changeMessage: c.changeMessage,
        createdAt: c.createdAt.toString(),
      })),
    };
  }

  public async fetchChangelogByVersion({ schemaVersionId }: { schemaVersionId: string }) {
    const changelogs = await this.db
      .select({
        id: schemaVersionChangeAction.id,
        path: schemaVersionChangeAction.path,
        changeType: schemaVersionChangeAction.changeType,
        changeMessage: schemaVersionChangeAction.changeMessage,
        createdAt: schemaVersionChangeAction.createdAt,
      })
      .from(schemaVersionChangeAction)
      .where(eq(schemaVersionChangeAction.schemaVersionId, schemaVersionId));

    if (changelogs.length === 0) {
      return [];
    }

    return changelogs.map((c) => ({
      id: c.id,
      path: c.path || '',
      changeType: c.changeType,
      changeMessage: c.changeMessage,
      createdAt: c.createdAt.toString(),
    }));
  }

  public delete(targetID: string) {
    return this.db.delete(targets).where(eq(targets.id, targetID)).execute();
  }

  public async createToken(input: {
    tokenName: string;
    token: string;
    organizationId: string;
    federatedGraphId: string;
    createdBy: string;
  }): Promise<GraphApiKeyDTO> {
    const keys = await this.db
      .insert(graphApiTokens)
      .values({
        name: input.tokenName,
        token: input.token,
        organizationId: input.organizationId,
        federatedGraphId: input.federatedGraphId,
        createdBy: input.createdBy,
      })
      .returning()
      .execute();

    if (keys.length === 0) {
      throw new Error('Failed to create token');
    }

    const userRepo = new UserRepository(this.db);
    const user = await userRepo.byId(input.createdBy);

    if (!user) {
      throw new Error('User not found');
    }

    const key = keys[0];

    return {
      id: key.id,
      name: key.name,
      token: key.token,
      createdAt: key.createdAt.toISOString(),
      creatorEmail: user.email,
      lastUsedAt: '',
    };
  }

  public async deleteToken(input: { tokenName: string; organizationId: string; federatedGraphId: string }) {
    await this.db
      .delete(graphApiTokens)
      .where(
        and(
          eq(graphApiTokens.organizationId, input.organizationId),
          eq(graphApiTokens.federatedGraphId, input.federatedGraphId),
          eq(graphApiTokens.name, input.tokenName),
        ),
      )
      .execute();
  }

  public async getRouterToken(input: {
    organizationId: string;
    federatedGraphId: string;
    tokenName: string;
  }): Promise<GraphApiKeyDTO | undefined> {
    const tokens = await this.db
      .select({
        id: graphApiTokens.id,
        name: graphApiTokens.name,
        createdAt: graphApiTokens.createdAt,
        lastUsedAt: graphApiTokens.lastUsedAt,
        creatorEmail: users.email,
        token: graphApiTokens.token,
      })
      .from(graphApiTokens)
      .leftJoin(users, eq(users.id, graphApiTokens.createdBy))
      .where(
        and(
          eq(graphApiTokens.organizationId, input.organizationId),
          eq(graphApiTokens.federatedGraphId, input.federatedGraphId),
          eq(graphApiTokens.name, input.tokenName),
        ),
      )
      .execute();

    if (tokens.length === 0) {
      return undefined;
    }

    return {
      id: tokens[0].id,
      name: tokens[0].name,
      createdAt: tokens[0].createdAt.toISOString(),
      token: tokens[0].token,
      creatorEmail: tokens[0].creatorEmail,
      lastUsedAt: tokens[0].lastUsedAt?.toISOString(),
    };
  }

  public async getRouterTokens(input: {
    organizationId: string;
    federatedGraphId: string;
    limit: number;
  }): Promise<GraphApiKeyDTO[]> {
    const tokens = await this.db
      .select({
        id: graphApiTokens.id,
        name: graphApiTokens.name,
        lastUsedAt: graphApiTokens.lastUsedAt,
        createdAt: graphApiTokens.createdAt,
        creatorEmail: users.email,
        token: graphApiTokens.token,
      })
      .from(graphApiTokens)
      .leftJoin(users, eq(users.id, graphApiTokens.createdBy))
      .where(
        and(
          eq(graphApiTokens.organizationId, input.organizationId),
          eq(graphApiTokens.federatedGraphId, input.federatedGraphId),
        ),
      )
      .orderBy(desc(graphApiTokens.createdAt))
      .limit(input.limit)
      .execute();

    return tokens.map((token) => ({
      id: token.id,
      name: token.name,
      createdAt: token.createdAt.toISOString(),
      lastUsedAt: token.lastUsedAt?.toISOString(),
      creatorEmail: token.creatorEmail,
      token: token.token,
    }));
  }

  public async createGraphCryptoKeyPairs(input: {
    organizationId: string;
    federatedGraphId: string;
  }): Promise<RouterRequestKeysDTO> {
    const keys = await generateKeyPair('ES256');

    const privateKey = (keys.privateKey as KeyObject).export({
      format: 'pem',
      type: 'pkcs8',
    });
    const publicKey = (keys.publicKey as KeyObject).export({
      format: 'pem',
      type: 'spki',
    });

    const items = await this.db
      .insert(graphRequestKeys)
      .values({
        privateKey: privateKey.toString(),
        publicKey: publicKey.toString(),
        organizationId: input.organizationId,
        federatedGraphId: input.federatedGraphId,
      })
      .returning()
      .execute();

    if (items.length === 0) {
      throw new Error('Failed to create request keys');
    }

    const key = items[0];

    return {
      id: key.id,
      privateKey: key.privateKey,
      publicKey: key.publicKey,
      createdAt: key.createdAt.toISOString(),
    };
  }

  public async getGraphPublicKey(input: {
    organizationId: string;
    federatedGraphId: string;
  }): Promise<string | undefined> {
    const keys = await this.db
      .select({
        publicKey: graphRequestKeys.publicKey,
      })
      .from(graphRequestKeys)
      .where(
        and(
          eq(graphRequestKeys.organizationId, input.organizationId),
          eq(graphRequestKeys.federatedGraphId, input.federatedGraphId),
        ),
      )
      .limit(1)
      .execute();

    if (keys.length === 0) {
      return undefined;
    }

    return keys[0].publicKey;
  }

  public async getGraphSignedToken(input: {
    organizationId: string;
    federatedGraphId: string;
  }): Promise<string | undefined> {
    const keys = await this.db
      .select({
        privateKey: graphRequestKeys.privateKey,
      })
      .from(graphRequestKeys)
      .where(
        and(
          eq(graphRequestKeys.organizationId, input.organizationId),
          eq(graphRequestKeys.federatedGraphId, input.federatedGraphId),
        ),
      )
      .limit(1)
      .execute();

    if (keys.length === 0) {
      return undefined;
    }

    const ecPrivateKey = await importPKCS8(keys[0].privateKey, 'ES256');

    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuedAt()
      .setIssuer(input.organizationId)
      .setAudience(input.federatedGraphId)
      .setExpirationTime('1d')
      .sign(ecPrivateKey);
  }

  public async getAccessibleFederatedGraphs(userId: string): Promise<FederatedGraphDTO[]> {
    const graphTargets = await this.db.query.targets.findMany({
      where: and(
        eq(targets.type, 'federated'),
        eq(targets.organizationId, this.organizationId),
        eq(targets.createdBy, userId),
      ),
    });

    const federatedGraphs: FederatedGraphDTO[] = [];

    for (const target of graphTargets) {
      const fg = await this.byTargetId(target.name);
      if (fg === undefined) {
        throw new Error(`FederatedGraph ${target.name} not found`);
      }
      federatedGraphs.push(fg);
    }

    return federatedGraphs;
  }
}
