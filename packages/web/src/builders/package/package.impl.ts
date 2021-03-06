import { join, relative } from 'path';
import {
  BuilderContext,
  BuilderOutput,
  createBuilder,
} from '@angular-devkit/architect';
import { JsonObject } from '@angular-devkit/core';
import { from, Observable, of } from 'rxjs';
import { catchError, last, switchMap, tap } from 'rxjs/operators';
import { getBabelInputPlugin } from '@rollup/plugin-babel';
import * as autoprefixer from 'autoprefixer';
import * as rollup from 'rollup';
import * as peerDepsExternal from 'rollup-plugin-peer-deps-external';
import * as postcss from 'rollup-plugin-postcss';
import * as filesize from 'rollup-plugin-filesize';
import * as localResolve from 'rollup-plugin-local-resolve';
import { toClassName } from '@nrwl/workspace/src/utils/name-utils';
import { BuildResult } from '@angular-devkit/build-webpack';
import {
  readJsonFile,
  writeJsonFile,
} from '@nrwl/workspace/src/utils/fileutils';
import { createProjectGraph } from '@nrwl/workspace/src/core/project-graph';

import {
  calculateProjectDependencies,
  checkDependentProjectsHaveBeenBuilt,
  computeCompilerOptionsPaths,
  DependentBuildableProjectNode,
  updateBuildableProjectPackageJsonDependencies,
} from '@nrwl/workspace/src/utils/buildable-libs-utils';
import { PackageBuilderOptions } from '../../utils/types';
import { runRollup } from './run-rollup';
import {
  NormalizedBundleBuilderOptions,
  NormalizedCopyAssetOption,
  normalizePackageOptions,
} from '../../utils/normalize';
import { getSourceRoot } from '../../utils/source-root';
import { createBabelConfig } from '../../utils/babel-config';

// These use require because the ES import isn't correct.
const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
const typescript = require('rollup-plugin-typescript2');
const image = require('@rollup/plugin-image');
const copy = require('rollup-plugin-copy');

export default createBuilder<PackageBuilderOptions & JsonObject>(run);

interface OutputConfig {
  format: rollup.ModuleFormat;
  extension: string;
  declaration?: boolean;
}

const outputConfigs: OutputConfig[] = [
  { format: 'umd', extension: 'umd' },
  { format: 'esm', extension: 'esm' },
];

const fileExtensions = ['.js', '.jsx', '.ts', '.tsx'];

export function run(
  rawOptions: PackageBuilderOptions,
  context: BuilderContext
): Observable<BuilderOutput> {
  const projGraph = createProjectGraph();
  const { target, dependencies } = calculateProjectDependencies(
    projGraph,
    context
  );

  return from(getSourceRoot(context)).pipe(
    switchMap((sourceRoot) => {
      if (!checkDependentProjectsHaveBeenBuilt(context, dependencies)) {
        return of({ success: false });
      }

      const options = normalizePackageOptions(
        rawOptions,
        context.workspaceRoot,
        sourceRoot
      );
      const packageJson = readJsonFile(options.project);
      const rollupOptions = createRollupOptions(
        options,
        dependencies,
        context,
        packageJson,
        sourceRoot
      );

      if (options.watch) {
        return new Observable<BuildResult>((obs) => {
          const watcher = rollup.watch([rollupOptions]);
          watcher.on('event', (data) => {
            if (data.code === 'START') {
              context.logger.info('Bundling...');
            } else if (data.code === 'END') {
              updatePackageJson(
                options,
                context,
                target,
                dependencies,
                packageJson
              );
              context.logger.info(
                'Bundle complete. Watching for file changes...'
              );
              obs.next({ success: true });
            } else if (data.code === 'ERROR') {
              context.logger.error(
                `Error during bundle: ${data.error.message}`
              );
              obs.next({ success: false });
            }
          });
          // Teardown logic. Close watcher when unsubscribed.
          return () => watcher.close();
        });
      } else {
        context.logger.info('Bundling...');
        return runRollup(rollupOptions).pipe(
          catchError((e) => {
            context.logger.error(`Error during bundle: ${e}`);
            return of({ success: false });
          }),
          last(),
          tap({
            next: (result) => {
              if (result.success) {
                updatePackageJson(
                  options,
                  context,
                  target,
                  dependencies,
                  packageJson
                );
                context.logger.info('Bundle complete.');
              } else {
                context.logger.error('Bundle failed.');
              }
            },
          })
        );
      }
    })
  );
}

// -----------------------------------------------------------------------------

export function createRollupOptions(
  options: NormalizedBundleBuilderOptions,
  dependencies: DependentBuildableProjectNode[],
  context: BuilderContext,
  packageJson: any,
  sourceRoot: string
): rollup.InputOptions {
  const compilerOptionPaths = computeCompilerOptionsPaths(
    options.tsConfig,
    dependencies
  );

  const plugins = [
    copy({
      targets: convertCopyAssetsToRollupOptions(
        options.outputPath,
        options.assets
      ),
    }),
    image(),
    typescript({
      check: true,
      tsconfig: options.tsConfig,
      tsconfigOverride: {
        compilerOptions: {
          rootDir: options.entryRoot,
          allowJs: false,
          declaration: true,
          paths: compilerOptionPaths,
        },
      },
    }),
    peerDepsExternal({
      packageJsonPath: options.project,
    }),
    postcss({
      inject: true,
      extract: options.extractCss,
      autoModules: true,
      plugins: [autoprefixer],
    }),
    localResolve(),
    resolve({
      preferBuiltins: true,
      extensions: fileExtensions,
    }),
    getBabelInputPlugin({
      // TODO(jack): Remove this in Nx 10
      ...legacyCreateBabelConfig(options, options.projectRoot),

      cwd: join(context.workspaceRoot, sourceRoot),
      rootMode: 'upward',
      babelrc: true,
      extensions: fileExtensions,
      babelHelpers: 'bundled',
      exclude: /node_modules/,
      plugins: [
        'babel-plugin-transform-async-to-promises',
        ['@babel/plugin-transform-regenerator', { async: false }],
      ],
    }),
    commonjs(),
    filesize(),
  ];

  const globals = options.globals
    ? options.globals.reduce((acc, item) => {
        acc[item.moduleId] = item.global;
        return acc;
      }, {})
    : {};

  const externalPackages = dependencies
    .map((d) => d.name)
    .concat(options.external || [])
    .concat(Object.keys(packageJson.dependencies || {}));

  const rollupConfig = {
    input: options.entryFile,
    output: outputConfigs.map((o) => {
      return {
        globals,
        format: o.format,
        file: `${options.outputPath}/${context.target.project}.${o.extension}.js`,
        name: toClassName(context.target.project),
      };
    }),
    external: (id) => externalPackages.includes(id),
    plugins,
  };

  return options.rollupConfig
    ? require(options.rollupConfig)(rollupConfig)
    : rollupConfig;
}

function legacyCreateBabelConfig(
  options: PackageBuilderOptions,
  projectRoot: string
) {
  if (options.babelConfig) {
    let babelConfig: any = createBabelConfig(projectRoot, false, false);
    babelConfig = require(options.babelConfig)(babelConfig, options);
    // Ensure async functions are transformed to promises properly.
    upsert(
      'plugins',
      'babel-plugin-transform-async-to-promises',
      null,
      babelConfig
    );
    upsert(
      'plugins',
      '@babel/plugin-transform-regenerator',
      { async: false },
      babelConfig
    );
  } else {
    return {};
  }

  function upsert(
    type: 'presets' | 'plugins',
    pluginOrPreset: string,
    opts: null | JsonObject,
    config: any
  ) {
    if (
      !config[type].some(
        (p) =>
          (Array.isArray(p) && p[0].indexOf(pluginOrPreset) !== -1) ||
          p.indexOf(pluginOrPreset) !== -1
      )
    ) {
      const fullPath = require.resolve(pluginOrPreset);
      config[type] = config[type].concat([opts ? [fullPath, opts] : fullPath]);
    }
  }
}

function updatePackageJson(
  options,
  context,
  target,
  dependencies,
  packageJson
) {
  const entryFileTmpl = `./${context.target.project}.<%= extension %>.js`;
  const typingsFile = relative(options.entryRoot, options.entryFile).replace(
    /\.[jt]sx?$/,
    '.d.ts'
  );
  packageJson.main = entryFileTmpl.replace('<%= extension %>', 'umd');
  packageJson.module = entryFileTmpl.replace('<%= extension %>', 'esm');
  packageJson.typings = `./${typingsFile}`;
  writeJsonFile(`${options.outputPath}/package.json`, packageJson);

  if (
    dependencies.length > 0 &&
    options.updateBuildableProjectDepsInPackageJson
  ) {
    updateBuildableProjectPackageJsonDependencies(
      context,
      target,
      dependencies
    );
  }
}

interface RollupCopyAssetOption {
  src: string;
  dest: string;
}

function convertCopyAssetsToRollupOptions(
  outputPath: string,
  assets: NormalizedCopyAssetOption[]
): RollupCopyAssetOption[] {
  return assets
    ? assets.map((a) => ({
        src: join(a.input, a.glob),
        dest: join(outputPath, a.output),
      }))
    : undefined;
}
