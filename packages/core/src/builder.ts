import * as fs from "fs";
import * as path from "path";

import * as mkdirp from "mkdirp";

import {
  Segment,
  Feature,
  DatafileContent,
  Variation,
  Variable,
  VariableOverride,
  Traffic,
  SegmentKey,
  AttributeKey,
  Attribute,
  GroupSegment,
  Condition,
  ExistingFeatures,
  ExistingFeature,
  ExistingState,
  ParsedFeature,
  FeatureKey,
  Allocation,
  EnvironmentKey,
  Group,
  Range,
} from "@featurevisor/types";

import { SCHEMA_VERSION, ProjectConfig } from "./config";
import { getTraffic } from "./traffic";
import {
  parseYaml,
  extractAttributeKeysFromConditions,
  extractSegmentKeysFromGroupSegments,
} from "./utils";

export interface BuildOptions {
  schemaVersion: string;
  revision: string;
  environment: string;
  tag: string;
}

export function getDatafilePath(
  projectConfig: ProjectConfig,
  environment: EnvironmentKey,
  tag: string,
): string {
  const fileName = `datafile-tag-${tag}.json`;

  return path.join(projectConfig.outputDirectoryPath, environment, fileName);
}

export function getExistingStateFilePath(
  projectConfig: ProjectConfig,
  environment: EnvironmentKey,
  tag: string,
): string {
  return path.join(projectConfig.stateDirectoryPath, `existing-state-${environment}-${tag}.json`);
}

export function buildDatafile(
  projectConfig: ProjectConfig,
  options: BuildOptions,
): DatafileContent {
  const datafileContent: DatafileContent = {
    schemaVersion: options.schemaVersion,
    revision: options.revision,
    attributes: [],
    segments: [],
    features: [],
  };

  const segmentKeysUsedByTag = new Set<SegmentKey>();
  const attributeKeysUsedByTag = new Set<AttributeKey>();
  const featureRanges = new Map<FeatureKey, Range[]>();

  // groups
  const groups: Group[] = [];
  if (fs.existsSync(projectConfig.groupsDirectoryPath)) {
    const groupFiles = fs
      .readdirSync(projectConfig.groupsDirectoryPath)
      .filter((f) => f.endsWith(".yml"));

    for (const groupFile of groupFiles) {
      const groupKey = path.basename(groupFile, ".yml");
      const groupFilePath = path.join(projectConfig.groupsDirectoryPath, groupFile);
      const parsedGroup = parseYaml(fs.readFileSync(groupFilePath, "utf8")) as Group;

      groups.push({
        ...parsedGroup,
        key: groupKey,
      });

      let accumulatedPercentage = 0;
      parsedGroup.slots.forEach(function (slot, slotIndex) {
        const isFirstSlot = slotIndex === 0;
        const isLastSlot = slotIndex === parsedGroup.slots.length - 1;

        if (slot.feature) {
          const featureKey = slot.feature;
          const featureRangesForFeature = featureRanges.get(featureKey) || [];

          const start = isFirstSlot ? accumulatedPercentage : accumulatedPercentage + 1;
          const end = accumulatedPercentage + slot.percentage * 1000;

          featureRangesForFeature.push({
            start,
            end,
          });

          featureRanges.set(slot.feature, featureRangesForFeature);
        }

        accumulatedPercentage += slot.percentage * 1000;
      });
    }
  }

  // features
  const features: Feature[] = [];
  const featuresDirectory = projectConfig.featuresDirectoryPath;

  let existingState = {} as ExistingState;
  let existingFeatures = {} as ExistingFeatures;

  const existingStateFilePath = getExistingStateFilePath(
    projectConfig,
    options.environment,
    options.tag,
  );

  if (fs.existsSync(existingStateFilePath)) {
    existingState = JSON.parse(fs.readFileSync(existingStateFilePath, "utf8")) as ExistingState;

    if (existingState && existingState.features) {
      existingFeatures = existingState.features;
    }
  }

  if (fs.existsSync(featuresDirectory)) {
    const featureFiles = fs.readdirSync(featuresDirectory).filter((f) => f.endsWith(".yml"));

    for (const featureFile of featureFiles) {
      const featureKey = path.basename(featureFile, ".yml") as FeatureKey;
      const featureFilePath = path.join(featuresDirectory, featureFile);
      const parsedFeature = parseYaml(fs.readFileSync(featureFilePath, "utf8")) as ParsedFeature;

      if (parsedFeature.archived === true) {
        continue;
      }

      if (parsedFeature.tags.indexOf(options.tag) === -1) {
        continue;
      }

      if (parsedFeature.environments[options.environment].expose === false) {
        continue;
      }

      for (const parsedRule of parsedFeature.environments[options.environment].rules) {
        const extractedSegmentKeys = extractSegmentKeysFromGroupSegments(parsedRule.segments);
        extractedSegmentKeys.forEach((segmentKey) => segmentKeysUsedByTag.add(segmentKey));
      }

      const feature: Feature = {
        key: featureKey,
        defaultVariation: parsedFeature.defaultVariation,
        bucketBy: parsedFeature.bucketBy || projectConfig.defaultBucketBy,
        variations: parsedFeature.variations.map((variation: Variation) => {
          const mappedVariation: any = {
            value: variation.value,
            weight: variation.weight, // @TODO: added so state files can maintain weight info, but datafiles don't need this. find a way to remove it from datafiles later
          };

          if (!variation.variables) {
            return mappedVariation;
          }

          mappedVariation.variables = variation.variables.map((variable: Variable) => {
            const mappedVariable: any = {
              key: variable.key,
              value: variable.value,
            };

            if (!variable.overrides) {
              return mappedVariable;
            }

            mappedVariable.overrides = variable.overrides.map((override: VariableOverride) => {
              if (typeof override.conditions !== "undefined") {
                const extractedAttributeKeys = extractAttributeKeysFromConditions(
                  override.conditions,
                );
                extractedAttributeKeys.forEach((attributeKey) =>
                  attributeKeysUsedByTag.add(attributeKey),
                );

                return {
                  conditions: JSON.stringify(override.conditions),
                  value: override.value,
                };
              }

              if (typeof override.segments !== "undefined") {
                const extractedSegmentKeys = extractSegmentKeysFromGroupSegments(
                  override.segments as GroupSegment | GroupSegment[],
                );
                extractedSegmentKeys.forEach((segmentKey) => segmentKeysUsedByTag.add(segmentKey));

                return {
                  segments: JSON.stringify(override.segments),
                  value: override.value,
                };
              }

              return override;
            });

            return mappedVariable;
          });

          return mappedVariation;
        }),
        traffic: getTraffic(
          parsedFeature.variations,
          parsedFeature.environments[options.environment].rules,
          existingFeatures && existingFeatures[featureKey],
          featureRanges.get(featureKey) || [],
        ),
      };

      if (parsedFeature.variablesSchema) {
        feature.variablesSchema = parsedFeature.variablesSchema;
      }

      if (parsedFeature.environments[options.environment].force) {
        feature.force = parsedFeature.environments[options.environment].force;
      }

      features.push(feature);
    }
  }

  // segments
  const segments: Segment[] = [];
  const segmentsDirectory = projectConfig.segmentsDirectoryPath;

  if (fs.existsSync(segmentsDirectory)) {
    const segmentFiles = fs.readdirSync(segmentsDirectory).filter((f) => f.endsWith(".yml"));

    for (const segmentFile of segmentFiles) {
      const segmentKey = path.basename(segmentFile, ".yml");
      const segmentFilePath = path.join(segmentsDirectory, segmentFile);
      const parsedSegment = parseYaml(fs.readFileSync(segmentFilePath, "utf8")) as Segment;

      if (parsedSegment.archived === true) {
        continue;
      }

      if (segmentKeysUsedByTag.has(segmentKey) === false) {
        continue;
      }

      const extractedAttributeKeys = extractAttributeKeysFromConditions(
        parsedSegment.conditions as Condition | Condition[],
      );
      extractedAttributeKeys.forEach((attributeKey) => attributeKeysUsedByTag.add(attributeKey));

      const segment: Segment = {
        key: segmentKey,
        conditions:
          typeof parsedSegment.conditions !== "string"
            ? JSON.stringify(parsedSegment.conditions)
            : parsedSegment.conditions,
      };

      segments.push(segment);
    }
  }

  // attributes
  const attributes: Attribute[] = [];
  const attributesDirectory = projectConfig.attributesDirectoryPath;

  if (fs.existsSync(attributesDirectory)) {
    const attributeFiles = fs.readdirSync(attributesDirectory).filter((f) => f.endsWith(".yml"));

    for (const attributeFile of attributeFiles) {
      const attributeKey = path.basename(attributeFile, ".yml");
      const attributeFilePath = path.join(attributesDirectory, attributeFile);
      const parsedAttribute = parseYaml(fs.readFileSync(attributeFilePath, "utf8")) as Attribute;

      if (parsedAttribute.archived === true) {
        continue;
      }

      if (attributeKeysUsedByTag.has(attributeKey) === false && !parsedAttribute.capture) {
        continue;
      }

      const attribute: Attribute = {
        key: attributeKey,
        type: parsedAttribute.type,
      };

      if (parsedAttribute.capture === true) {
        attribute.capture = true;
      }

      attributes.push(attribute);
    }
  }

  datafileContent.attributes = attributes;
  datafileContent.segments = segments;
  datafileContent.features = features;

  // write
  const outputEnvironmentDirPath = path.join(
    projectConfig.outputDirectoryPath,
    options.environment,
  );
  mkdirp.sync(outputEnvironmentDirPath);

  const outputFilePath = getDatafilePath(projectConfig, options.environment, options.tag);
  fs.writeFileSync(outputFilePath, JSON.stringify(datafileContent));

  // write to state directory
  if (!fs.existsSync(projectConfig.stateDirectoryPath)) {
    mkdirp.sync(projectConfig.stateDirectoryPath);
  }

  const updatedExistingFeatures = datafileContent.features.reduce((acc, feature) => {
    const item: ExistingFeature = {
      variations: feature.variations.map((v: Variation) => {
        return {
          value: v.value,
          weight: v.weight || 0,
        };
      }),
      traffic: feature.traffic.map((t: Traffic) => {
        return {
          key: t.key,
          percentage: t.percentage, // @TODO: remove this in next breaking semver
          allocation: t.allocation.map((a: Allocation) => {
            return {
              variation: a.variation,
              percentage: a.percentage, // @TODO: remove this in next breaking semver
              range: a.range,
            };
          }),
        };
      }),
      ranges: featureRanges.get(feature.key) || undefined,
    };

    acc[feature.key] = item;

    return acc;
  }, existingFeatures);

  const updatedState: ExistingState = {
    features: updatedExistingFeatures,
  };

  fs.writeFileSync(existingStateFilePath, JSON.stringify(updatedState));

  console.log(`     File generated: ${outputFilePath}`);

  return datafileContent;
}

export function buildProject(rootDirectoryPath, projectConfig: ProjectConfig) {
  const tags = projectConfig.tags;
  const environments = projectConfig.environments;

  const pkg = require(path.join(rootDirectoryPath, "package.json"));

  for (const environment of environments) {
    console.log(`\nBuilding datafiles for environment: ${environment}`);

    for (const tag of tags) {
      console.log(`  => Tag: ${tag}`);
      buildDatafile(projectConfig, {
        schemaVersion: SCHEMA_VERSION,
        revision: pkg.version,
        environment: environment,
        tag: tag,
      });
    }
  }
}
