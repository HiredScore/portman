import { camelCase } from 'camel-case'
import chalk from 'chalk'
import * as Either from 'fp-ts/lib/Either'
import fs from 'fs-extra'
import { NewmanRunOptions } from 'newman'
import emoji from 'node-emoji'
import path from 'path'
import { Collection, CollectionDefinition, Item, ItemGroup } from 'postman-collection'
import {
  CollectionWriter,
  IntegrationTestWriter,
  runNewmanWith,
  TestSuite,
  VariationWriter,
  writeNewmanEnv,
  writeRawReplacements
} from './application'
import { clearTmpDirectory, execShellCommand, getConfig } from './lib'
import { OpenApiParser } from './oas'
import { PostmanParser } from './postman'
import {
  DownloadService,
  IOpenApiToPostmanConfig,
  OpenApiToPostmanService,
  PostmanApiService
} from './services'
import { PortmanConfig } from './types'
import { PortmanOptions } from './types/PortmanOptions'
import { validate } from './utils/PortmanConfig.validator'

export class Portman {
  config: PortmanConfig
  options: PortmanOptions
  oasParser: OpenApiParser
  postmanParser: PostmanParser
  postmanCollection: Collection
  portmanCollection: CollectionDefinition
  testSuite: TestSuite
  variationWriter: VariationWriter
  integrationTestWriter: IntegrationTestWriter
  consoleLine: string

  public collectionFile: string

  constructor(options: PortmanOptions) {
    this.options = options
    this.consoleLine = process.stdout.columns ? '='.repeat(process.stdout.columns) : '='.repeat(80)
  }

  async run(): Promise<void> {
    await this.before()
    if (!this.config) return

    await this.parseOpenApiSpec()
    await this.convertToPostmanCollection()
    this.injectTestSuite()
    this.injectVariationTests()
    this.injectVariationOverwrites()
    this.injectIntegrationTests()
    this.moveContractTestsToFolder()
    this.writePortmanCollectionToFile()
    await this.runNewmanSuite()
    await this.syncCollectionToPostman()

    return await this.after()
  }

  async uploadOnly(): Promise<void> {
    const localPostman = this.options.output || ''
    if (localPostman === '') {
      throw new Error(`Loading ${localPostman} failed.`)
    }
    this.options.syncPostman = true

    await this.before()

    try {
      const postmanJson = path.resolve(localPostman)
      this.portmanCollection = new Collection(
        JSON.parse(fs.readFileSync(postmanJson, 'utf8').toString())
      )
      await this.syncCollectionToPostman()
    } catch (err) {
      throw new Error(`Loading ${localPostman} failed.`)
    }
  }

  async before(): Promise<void> {
    const {
      consoleLine,
      options: {
        oaUrl,
        oaLocal,
        output,
        cliOptionsFile,
        portmanConfigFile,
        portmanConfigPath,
        postmanConfigFile,
        filterFile,
        oaOutput,
        envFile,
        includeTests,
        bundleContractTests,
        runNewman,
        newmanIterationData,
        syncPostman
      }
    } = this

    // --- Portman - Show processing output
    console.log(chalk.red(consoleLine))

    oaUrl && console.log(chalk`{cyan  Remote Url: } \t\t{green ${oaUrl}}`)
    oaLocal && console.log(chalk`{cyan  Local Path: } \t\t{green ${oaLocal}}`)
    output && console.log(chalk`{cyan  Output Path: } \t\t{green ${output}}`)
    oaOutput && console.log(chalk`{cyan  OpenAPI Output Path: } \t{green ${oaOutput}}`)

    cliOptionsFile && console.log(chalk`{cyan  Portman CLI Config: } \t{green ${cliOptionsFile}}`)
    console.log(
      chalk`{cyan  Portman Config: } \t{green ${
        portmanConfigFile ? portmanConfigFile : 'portman-config.default.json'
      }}`
    )
    console.log(
      chalk`{cyan  Postman Config: } \t{green ${
        postmanConfigFile ? postmanConfigFile : 'postman-config.default.json'
      }}`
    )

    filterFile && console.log(chalk`{cyan  Filter Config: } \t{green ${filterFile}}`)

    console.log(chalk`{cyan  Environment: } \t\t{green ${envFile}}`)
    console.log(chalk`{cyan  Inject Tests: } \t{green ${includeTests}}`)
    bundleContractTests &&
      console.log(chalk`{cyan  Bundle Tests: } \t{green ${bundleContractTests}}`)
    console.log(chalk`{cyan  Run Newman: } \t\t{green ${!!runNewman}}`)
    console.log(
      chalk`{cyan  Newman Iteration Data: }{green ${
        newmanIterationData ? newmanIterationData : false
      }}`
    )
    console.log(chalk`{cyan  Upload to Postman: } \t{green ${syncPostman}}  `)
    console.log(chalk.red(consoleLine))

    await fs.ensureDir('./tmp/working/')
    await fs.ensureDir('./tmp/converted/')
    await fs.ensureDir('./tmp/newman/')

    const configJson = await getConfig(portmanConfigPath)
    const config = validate(configJson)

    if (Either.isLeft(config)) {
      console.log(chalk`{red  Invalid Portman Config: } \t\t{green ${portmanConfigPath}}`)
      console.log(config.left)
      console.log(chalk.red(consoleLine))
    } else {
      this.config = config.right
    }
  }

  async after(): Promise<void> {
    const { consoleLine, collectionFile } = this
    await clearTmpDirectory()
    console.log(chalk.green(consoleLine))

    console.log(
      emoji.get(':rocket:'),
      chalk`{cyan Collection written to:} {green ${collectionFile}}`,
      emoji.get(':rocket:')
    )

    console.log(chalk.green(consoleLine))
  }

  async parseOpenApiSpec(): Promise<void> {
    // --- OpenApi - Get OpenApi file locally or remote
    const { oaLocal, oaUrl, filterFile, oaOutput } = this.options

    let openApiSpec = oaUrl && (await new DownloadService().get(oaUrl))

    if (oaLocal) {
      try {
        const oaLocalPath = path.resolve(oaLocal)
        await fs.copyFile(oaLocalPath, './tmp/converted/spec.yml')
        openApiSpec = './tmp/converted/spec.yml'
      } catch (err) {
        console.error('\x1b[31m', 'Local OAS error - no such file or directory "' + oaLocal + '"')
        process.exit(1)
      }
    }

    if (!openApiSpec) {
      throw new Error(`Error initializing OpenApi Spec.`)
    }

    const specExists = await fs.pathExists(openApiSpec)

    if (!specExists) {
      throw new Error(`${openApiSpec} doesn't exist. `)
    }

    if (filterFile && (await fs.pathExists(filterFile))) {
      const openApiSpecPath = oaOutput ? oaOutput : './tmp/converted/filtered.yml'

      await execShellCommand(
        `npx openapi-format ${openApiSpec} -o ${openApiSpecPath} --yaml --filterFile ${filterFile}`
      )
      openApiSpec = openApiSpecPath
    }

    const oasParser = new OpenApiParser()
    await oasParser
      .convert({
        inputFile: openApiSpec
      })
      .catch(err => {
        console.log('error: ', err)
        throw new Error(`Parsing ${openApiSpec} failed.`)
      })

    this.oasParser = oasParser
  }

  async convertToPostmanCollection(): Promise<void> {
    // --- openapi-to-postman - Transform OpenApi to Postman collection
    const { postmanConfigPath, localPostman } = this.options

    const oaToPostman = new OpenApiToPostmanService()
    // TODO investigate better way to keep oasParser untouched
    // Clone oasParser to prevent altering with added minItems maxItems
    const { oas } = this.oasParser
    const oaToPostmanConfig: IOpenApiToPostmanConfig = {
      openApiObj: { ...oas },
      outputFile: `${process.cwd()}/tmp/working/tmpCollection.json`,
      configFile: postmanConfigPath as string
    }

    let postmanObj: Record<string, unknown>

    if (localPostman) {
      try {
        const postmanJson = path.resolve(localPostman)
        postmanObj = JSON.parse(fs.readFileSync(postmanJson, 'utf8').toString())
      } catch (err) {
        throw new Error(`Loading ${localPostman} failed.`)
      }
    } else {
      postmanObj = await oaToPostman.convert(oaToPostmanConfig).catch(err => {
        console.log('error: ', err)
        throw new Error(`Postman Collection generation failed.`)
      })
    }

    await this.runPortmanOverrides(postmanObj)

    this.postmanParser = new PostmanParser({
      collection: this.postmanCollection,
      oasParser: this.oasParser
    })

    this.portmanCollection = this.postmanParser.collection.toJSON()
  }

  injectTestSuite(): void {
    const {
      config,
      options: { includeTests },
      oasParser,
      postmanParser
    } = this

    if (includeTests) {
      const testSuite = new TestSuite({ oasParser, postmanParser, config })
      // Inject automated tests
      testSuite.generateContractTests()

      // Inject content tests
      testSuite.injectContentTests()

      // Inject variable assignment
      testSuite.injectAssignVariables()

      // Inject postman extended tests
      testSuite.injectExtendedTests()

      // Inject overwrites
      testSuite.injectOverwrites()

      // Inject PreRequestScripts
      testSuite.injectPreRequestScripts()

      this.testSuite = testSuite
      this.portmanCollection = testSuite.collection.toJSON()
    }
  }

  injectVariationTests(): void {
    const {
      options: { includeTests },
      testSuite
    } = this

    if (
      includeTests &&
      testSuite &&
      testSuite?.variationTests?.length &&
      testSuite?.variationTests?.length > 0
    ) {
      // Inject variations
      this.variationWriter = new VariationWriter({
        testSuite: testSuite,
        variationFolderName: 'Variation Tests'
      })
      testSuite.variationWriter = this.variationWriter
      testSuite.generateVariationTests()

      this.portmanCollection = testSuite.collection.toJSON()
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-types
  async runPortmanOverrides(postmanCollection: CollectionDefinition): Promise<void> {
    // --- Portman - Overwrite Postman variables & values
    const { config, options } = this
    const collectionWriter = new CollectionWriter(config, options, postmanCollection)
    collectionWriter.execute()

    this.postmanCollection = new Collection(collectionWriter.collection)
  }

  injectIntegrationTests(): void {
    const {
      options: { includeTests },
      testSuite
    } = this

    if (includeTests && testSuite) {
      // Inject variations
      this.integrationTestWriter = new IntegrationTestWriter({
        testSuite: testSuite,
        integrationTestFolderName: 'Integration Tests'
      })

      testSuite.integrationTestWriter = this.integrationTestWriter
      testSuite.generateIntegrationTests()

      this.portmanCollection = testSuite.collection.toJSON()
    }
  }

  injectVariationOverwrites(): void {
    const { testSuite, variationWriter } = this
    if (!variationWriter || !testSuite) return

    this.postmanParser.map(this.portmanCollection)
    Object.entries(variationWriter.overwriteMap).map(([id, overwrites]) => {
      const pmOperation = this.postmanParser.getOperationByItemId(id)
      pmOperation && testSuite.injectOverwrites([pmOperation], overwrites)
    })

    this.portmanCollection = this.postmanParser.collection.toJSON()
  }

  moveContractTestsToFolder(): void {
    if (!this.options.bundleContractTests) return

    let pmOperationsWithContractTest: string[] = []
    const tests = this.testSuite.contractTests
    if (!tests) return

    // map back over settings and get all operation ids that have contract tests
    tests.map(contractTest => {
      const operations = this.testSuite.getOperationsFromSetting(contractTest)

      operations.map(pmOperation => {
        pmOperationsWithContractTest.push(pmOperation.item.id)
      })
    })

    // unique ids only
    pmOperationsWithContractTest = Array.from(new Set(pmOperationsWithContractTest))

    // create contract test folder
    const contractTestFolder = new ItemGroup({
      name: `Contract Tests`
    }) as ItemGroup<Item>

    pmOperationsWithContractTest.map(id => {
      const pmOperation = this.postmanParser.getOperationByItemId(id)
      let target: ItemGroup<Item>

      if (pmOperation) {
        // get the folder this operation is in
        const parent = pmOperation.getParent()

        if (parent) {
          // remove the operation from the folder
          parent?.items.remove(item => item.id === id, {})

          // If we just removed the last item, remove the folder
          if (parent?.items.count() === 0) {
            this.postmanParser.collection.items.remove(item => item.id === parent.id, {})
          }

          if (!Collection.isCollection(parent)) {
            // check if we've already recreated operations folder in Contract Test folder
            const folderName = parent.name
            const folder: unknown = contractTestFolder.oneDeep(folderName)

            if (folder) {
              target = folder as ItemGroup<Item>
            } else {
              // recreate the operations original folder to move operation to
              const newFolder = new ItemGroup({
                name: folderName
              }) as ItemGroup<Item>
              contractTestFolder.items.add(newFolder)
              target = newFolder
            }
          } else {
            target = contractTestFolder
          }
          target.items.add(pmOperation.item)
        }
      }
    })

    // all done, add contract test folder to root of collection
    this.postmanParser.collection.items.add(contractTestFolder)
    this.portmanCollection = this.postmanParser.collection.toJSON()
  }

  writePortmanCollectionToFile(): void {
    // --- Portman - Write Postman collection to file
    const { output } = this.options
    const { globals } = this.config
    const fileName = this?.portmanCollection?.info?.name || 'portman-collection'

    let postmanCollectionFile = `./tmp/converted/${camelCase(fileName)}.json`
    if (output) {
      postmanCollectionFile = output as string
      if (!postmanCollectionFile.includes('.json')) {
        console.error(
          '\x1b[31m',
          'Output file error - Only .json filenames are allowed for "' + postmanCollectionFile + '"'
        )
        process.exit(1)
      }
    }

    try {
      let collectionString = JSON.stringify(this.portmanCollection, null, 2)

      // --- Portman - Replace & clean-up Portman
      if (globals?.portmanReplacements) {
        collectionString = writeRawReplacements(collectionString, globals.portmanReplacements)
        this.portmanCollection = new Collection(JSON.parse(collectionString))
      }

      fs.writeFileSync(postmanCollectionFile, collectionString, 'utf8')
      this.collectionFile = postmanCollectionFile
    } catch (err) {
      console.error(
        '\x1b[31m',
        'Output file error - no such file or directory "' + postmanCollectionFile + '"'
      )
      process.exit(1)
    }
  }

  async runNewmanSuite(): Promise<void> {
    // --- Portman - Execute Newman tests
    const {
      consoleLine,
      options: { runNewman, baseUrl, newmanIterationData, newmanRunOptions = {} }
    } = this

    if (runNewman) {
      const fileName = this?.portmanCollection?.info?.name || 'portman-collection'
      const newmanEnvFile = `./tmp/newman/${fileName}-env.json`
      writeNewmanEnv(this.portmanCollection, newmanEnvFile)

      try {
        console.log(chalk.green(consoleLine))
        console.log(chalk`{cyan  Run Newman against: } {green ${baseUrl}}`)
        console.log(chalk.green(consoleLine))

        await runNewmanWith(
          this.collectionFile,
          newmanEnvFile,
          newmanIterationData,
          newmanRunOptions as Partial<NewmanRunOptions>
        )
      } catch (error) {
        console.log(`\n`)
        console.log(chalk.red(consoleLine))
        console.log(chalk.red(`Newman run failed with: `))
        console.log(error?.message)
        process.exit(1)
      }
    }
  }

  async syncCollectionToPostman(): Promise<void> {
    // --- Portman - Upload Postman collection to Postman app
    const {
      portmanCollection,
      options: { syncPostman }
    } = this
    const postmanUid = this.options?.postmanUid
      ? this.options.postmanUid
      : process.env.POSTMAN_COLLECTION_UID || ''
    const postmanWorkspaceName = this.options?.postmanWorkspaceName
      ? this.options.postmanWorkspaceName
      : process.env.POSTMAN_WORKSPACE_NAME || ''
    const consoleLine = process.stdout.columns ? '='.repeat(process.stdout.columns) : '='.repeat(80)
    const portmanCacheFile = './tmp/.portman.cache'
    let portmanCache = {}
    let remoteWorkspaceId: string | undefined
    let remoteWorkspace: { id?: string; name?: string; type?: string }
    const workspaceTarget = 'postman-workspace'
    let respData = ''
    let msgReason: string | undefined
    let msgSolution: string | undefined
    let reTry = false

    if (syncPostman) {
      const collName = portmanCollection?.info?.name as string
      let collUid = collName // fallback

      try {
        const portmanCachePath = path.resolve(portmanCacheFile)
        portmanCache = JSON.parse(fs.readFileSync(portmanCachePath, 'utf8').toString())

        if (postmanWorkspaceName && portmanCache[workspaceTarget]) {
          // Get remoteWorkspace from cache
          remoteWorkspace = portmanCache[workspaceTarget]
          // Set remoteWorkspaceId from cache
          remoteWorkspaceId = remoteWorkspace?.id
        } else {
          // Remove invalid cache item
          delete portmanCache[workspaceTarget]
        }
      } catch (err) {
        // throw new Error(`Loading Portman cache failed.`)
      }

      // Set remoteWorkspaceId from cache or by workspace name
      if (postmanWorkspaceName) {
        if (
          !portmanCache[workspaceTarget] ||
          (portmanCache && portmanCache[workspaceTarget] !== postmanWorkspaceName)
        ) {
          const postman = new PostmanApiService()
          remoteWorkspace = (await postman.findWorkspaceByName(postmanWorkspaceName)) as Record<
            string,
            unknown
          >
          if (remoteWorkspace?.id) {
            // Set remoteWorkspaceId from by workspace name
            remoteWorkspaceId = remoteWorkspace.id

            // Merge item data with cache
            portmanCache = Object.assign({}, portmanCache, {
              [workspaceTarget]: remoteWorkspace
            })
          }
        }
      }

      // Handle postmanUid from options
      if (postmanUid) {
        collUid = postmanUid
        const postman = new PostmanApiService()
        respData = await postman.updateCollection(portmanCollection, collUid, remoteWorkspaceId)

        msgReason = `Targeted Postman collection ID ${collUid} does not exist.`
        msgSolution = `Review the collection ID defined for the 'postmanUid' setting.`

        const { data } = JSON.parse(respData)
        if (data?.error?.message) {
          msgReason = data.error.message

          if (data?.error?.name && data?.error?.name === 'instanceNotFoundError') {
            msgReason += ` Targeted Postman collection ID ${collUid} does not exist.`
          }
        }
      }

      // Handle non-fixed postmanUid from cache or by collection name
      if (!postmanUid) {
        let remoteCollection = portmanCache[collName] as Record<string, unknown>

        if (!portmanCache[collName]) {
          if (remoteWorkspaceId) {
            // Get collection from specific Workspace
            const postman = new PostmanApiService()
            remoteCollection = (await postman.findWorkspaceCollectionByName(
              remoteWorkspaceId,
              collName
            )) as Record<string, unknown>
          } else {
            // Get all collections
            const postman = new PostmanApiService()
            remoteCollection = (await postman.findCollectionByName(collName)) as Record<
              string,
              unknown
            >
          }
        }

        if (remoteCollection?.uid) {
          // Update collection by Uid
          const postman = new PostmanApiService()
          respData = await postman.updateCollection(
            portmanCollection,
            remoteCollection.uid as string,
            remoteWorkspaceId
          )
          const { status, data } = JSON.parse(respData)

          // Update cache
          if (status === 'fail') {
            // Remove invalid cache item
            delete portmanCache[collName]
          } else {
            // Merge item data with cache
            portmanCache = Object.assign({}, portmanCache, {
              [collName]: {
                name: collName,
                uid: data?.collection?.uid
              }
            })
          }
          // Write portman cache
          try {
            const portmanCacheStr = JSON.stringify(portmanCache, null, 2)
            fs.writeFileSync(portmanCacheFile, portmanCacheStr, 'utf8')
          } catch (err) {
            // skip writing file, continue
          }

          // Restart on invalid Postman Uid and use Postman name as sync identifier
          if (status === 'fail') {
            reTry = true
            await this.syncCollectionToPostman()
          }
        } else {
          // Create collection
          const postman = new PostmanApiService()
          respData = await postman.createCollection(portmanCollection, remoteWorkspaceId)
          const { status, data } = JSON.parse(respData)

          // Update cache
          if (status === 'success') {
            // Merge item data with cache
            portmanCache = Object.assign({}, portmanCache, {
              [collName]: {
                name: collName,
                uid: data?.collection?.uid
              }
            })

            // Write portman cache
            try {
              const portmanCacheStr = JSON.stringify(portmanCache, null, 2)
              fs.writeFileSync(portmanCacheFile, portmanCacheStr, 'utf8')
            } catch (err) {
              // skip writing file, continue
            }
          }
        }
      }

      if (respData && !reTry) {
        // Process Postman API response as console output
        const { status, data } = JSON.parse(respData)

        if (status === 'success') {
          console.log(chalk`{cyan    -> Postman Name: } \t{green ${data?.collection?.name}}`)
          console.log(chalk`{cyan    -> Postman UID: } \t{green ${data?.collection?.uid}}`)
        }

        if (status === 'fail') {
          if (msgReason) console.log(chalk`{red    -> Reason: } \t\t${msgReason}`)
          if (msgSolution) console.log(chalk`{red    -> Solution: } \t${msgSolution}`)

          console.log(chalk`{red    -> Postman Name: } \t${portmanCollection?.info?.name}`)
          console.log(chalk`{red    -> Postman UID: } \t${collUid}`)

          console.log(data?.error)
          console.log(`\n`)
          console.log(chalk.red(consoleLine))
          process.exit(1)
        }
      }
    }
  }
}
