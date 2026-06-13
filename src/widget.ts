import { promisifyEventSource, swap } from '@softsky/utils'

import { Base } from './base'
import { Me, WPlaceBot } from './bot'
import { NoImageError, WPlaceBotError } from './errors'
import { BotImage } from './image'
import { Pixels } from './pixels'
import { save } from './save'
// @ts-ignore
import html from './widget.html' with { type: 'text' }
import { WorldPosition } from './world-position'

export enum BotStrategy {
  ALL = 'ALL',
  PERCENTAGE = 'PERCENTAGE',
  SEQUENTIAL = 'SEQUENTIAL',
}

/** Widget UI with buttons */
export class Widget extends Base {
  public readonly element = document.createElement('div')

  protected meCache?: { time: number; text: string }

  public get status(): string {
    return this.$status.innerHTML
  }

  public set status(value: string) {
    this.$status.innerHTML = value
  }

  public get open() {
    return this.element.classList.contains('wopen')
  }
  public set open(value) {
    if (value) this.element.classList.add('wopen')
    else this.element.classList.remove('wopen')
  }

  protected readonly $settings!: HTMLDivElement
  protected readonly $status!: HTMLDivElement
  protected readonly $minimize!: HTMLButtonElement
  protected readonly $topbar!: HTMLDivElement
  protected readonly $draw!: HTMLButtonElement
  protected readonly $addImage!: HTMLButtonElement
  protected readonly $strategy!: HTMLInputElement
  protected readonly $progressLine!: HTMLDivElement
  protected readonly $progressText!: HTMLSpanElement
  protected readonly $images!: HTMLDivElement
  protected readonly $imageSettingsHost!: HTMLDivElement
  protected readonly $fretime!: HTMLDivElement
  protected readonly $wopenButton!: HTMLButtonElement

  // protected readonly $pumpkinHunt!: HTMLButtonElement

  public constructor(protected bot: WPlaceBot) {
    super()
    this.element.classList.add('wwidget')
    this.element.innerHTML = html as unknown as string
    document.body.append(this.element)

    this.populateElementsWithSelector(this.element, {
      $wopenButton: '.wopen-button',
      $settings: '.wform',
      $status: '.wstatus',
      $fretime: '.fretime',
      $minimize: '.minimize',
      $topbar: '.wtopbar',
      $draw: '.draw',
      $addImage: '.add-image',
      $strategy: '.strategy',
      $progressLine: '.wprogress div',
      $progressText: '.wprogress span',
      $images: '.images',
      $imageSettingsHost: '.image-settings-host',
      // $pumpkinHunt: '.pumpkin-hunt',
    })

    // Button actions
    this.$wopenButton.addEventListener('click', () => (this.open = !this.open))
    this.$draw.addEventListener('click', () => {
      this.meCache = undefined
      void this.bot.draw()
    })
    // this.$pumpkinHunt.addEventListener('click', () => this.pumpkinHunt())
    this.$addImage.addEventListener('click', () => this.addImage())
    this.$strategy.addEventListener('change', () => {
      this.bot.strategy = this.$strategy.value as BotStrategy
    })

    this.update()
    this.open = true
  }

  /** Add image handler */
  public addImage() {
    this.setDisabled('add-image', true)
    return this.run(
      'Adding image',
      async () => {
        await this.bot.updateColors()
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'image/*,.wbot'
        input.click()
        await promisifyEventSource(input, ['change'], ['cancel', 'error'])
        const file = input.files?.[0]
        if (!file) throw new NoImageError(this.bot)
        let botImage
        if (file.name.endsWith('.wbot')) {
          botImage = await BotImage.fromJSON(
            this.bot,
            JSON.parse(await file.text()) as ReturnType<BotImage['toJSON']>,
          )
        } else {
          const reader = new FileReader()
          reader.readAsDataURL(file)
          await promisifyEventSource(reader, ['load'], ['error'])
          const image = new Image()
          image.src = reader.result as string
          await promisifyEventSource(image, ['load'], ['error'])
          const coords = await this.promptCoordinates()
          if (coords) {
            botImage = new BotImage(
              this.bot,
              new WorldPosition(
                this.bot,
                coords.tileX,
                coords.tileY,
                coords.pixelX,
                coords.pixelY,
              ),
              new Pixels(this.bot, image),
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              true,
            )
          } else {
            botImage = new BotImage(
              this.bot,
              WorldPosition.fromScreenPosition(this.bot, { x: 256, y: 32 }),
              new Pixels(this.bot, image),
            )
          }
        }
        this.bot.images.push(botImage)
        await this.bot.readMap()
        botImage.updateTasks()
        save(this.bot, true)
        document.location.reload()
      },
      () => {
        this.setDisabled('add-image', false)
      },
    )
  }

  /** Update widget position and contents */
  public update() {
    this.$strategy.value = this.bot.strategy
    void this.updateChargeInfo()
    // Progress
    let maxTasks = 0
    let totalTasks = 0
    for (let index = 0; index < this.bot.images.length; index++) {
      const image = this.bot.images[index]!
      maxTasks += image.pixels.pixels.length * image.pixels.pixels[0]!.length
      totalTasks += image.tasks.length
    }
    const doneTasks = maxTasks - totalTasks
    const percent = ((doneTasks / maxTasks) * 100) | 0
    this.$progressText.textContent = `${doneTasks}/${maxTasks} ${percent}% ETA: ${(totalTasks / 120) | 0}h`
    this.$progressLine.style.transform = `scaleX(${percent}%)`

    // Images
    this.$images.innerHTML = ''
    for (let index = 0; index < this.bot.images.length; index++) {
      const image = this.bot.images[index]!
      const $image = document.createElement('div')
      this.$images.append($image)
      $image.className = 'image'
      $image.innerHTML = `<img src="${image.pixels.image.src}">
  <button class="up" title="Move up" ${index === 0 ? 'disabled' : ''}>▴</button>
  <button class="down" title="Move down" ${index === this.bot.images.length - 1 ? 'disabled' : ''}>▾</button>`
      $image
        .querySelector<HTMLButtonElement>('img')!
        .addEventListener('click', () => {
          image.position.scrollScreenTo()
        })
      $image
        .querySelector<HTMLButtonElement>('.up')!
        .addEventListener('click', () => {
          swap(this.bot.images, index, index - 1)
          this.update()
          save(this.bot)
        })
      $image
        .querySelector<HTMLButtonElement>('.down')!
        .addEventListener('click', () => {
          swap(this.bot.images, index, index + 1)
          this.update()
          save(this.bot)
        })
    }
  }

  protected async updateChargeInfo() {
    const now = Date.now()
    if (this.meCache && now - this.meCache.time < 30000) {
      this.$fretime.textContent = this.meCache.text
      return
    }
    try {
      const me = (await fetch('https://backend.wplace.live/me', {
        credentials: 'include',
      }).then((x) => x.json())) as Me
      const max = me.charges.max
      const cooldownMs = me.charges.cooldownMs
      const totalMs = max * cooldownMs
      const totalMin = totalMs / 60000
      let text: string
      if (totalMin >= 60)
        text = `Full bar: ~${(totalMin / 60) | 0}h ${totalMin % 60 | 0}m`
      else text = `Full bar: ~${totalMin | 0}m`
      this.meCache = { time: now, text }
      this.$fretime.textContent = text
    } catch {
      /* ignore fetch errors */
    }
  }

  /** Disable/enable element by class name */
  public setDisabled(name: string, disabled: boolean) {
    this.element.querySelector<HTMLButtonElement>('.' + name)!.disabled =
      disabled
  }

  public showImageSettings(settings: HTMLDivElement) {
    this.$imageSettingsHost.classList.remove('hidden')
    this.$imageSettingsHost.replaceChildren(settings)
  }

  public hideImageSettings(settings?: HTMLDivElement) {
    if (settings && this.$imageSettingsHost.firstElementChild !== settings) return
    this.$imageSettingsHost.replaceChildren()
    this.$imageSettingsHost.classList.add('hidden')
  }

  /** Show status of running task */
  public async run<T>(
    status: string,
    run: () => Promise<T>,
    fin?: () => unknown,
    emoji = '⌛',
  ): Promise<T> {
    const originalStatus = this.status
    this.status = `${emoji} ${status}`
    try {
      const result = await run()
      this.status = originalStatus
      return result
    } catch (error) {
      if (!(error instanceof WPlaceBotError)) {
        console.error(error)
        this.status = `❌ ${status}`
      }
      throw error
    } finally {
      await fin?.()
    }
  }

  /** Hides content */
  protected minimize() {
    this.$settings.classList.toggle('hidden')
  }

  /** Show coordinate input dialog, returns coords or undefined for default */
  protected promptCoordinates(): Promise<
    | {
        tileX: number
        tileY: number
        pixelX: number
        pixelY: number
      }
    | undefined
  > {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div')
      backdrop.style.cssText =
        'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center'
      const dialog = document.createElement('div')
      dialog.className = 'wform'
      dialog.style.cssText =
        'display:block;border:var(--text) 2px solid;padding:16px;min-width:280px;pointer-events:auto'
      dialog.innerHTML = `<div style="font-size:18px;margin-bottom:8px;text-align:center">Place Image</div>
        <label style="display:flex;justify-content:space-between;margin:6px 0;align-items:center">Tile X <input class="tilex" type="number" style="width:120px" value="0"></label>
        <label style="display:flex;justify-content:space-between;margin:6px 0;align-items:center">Tile Y <input class="tiley" type="number" style="width:120px" value="0"></label>
        <label style="display:flex;justify-content:space-between;margin:6px 0;align-items:center">Pixel X <input class="pixelx" type="number" min="0" max="999" style="width:120px" value="0"></label>
        <label style="display:flex;justify-content:space-between;margin:6px 0;align-items:center">Pixel Y <input class="pixely" type="number" min="0" max="999" style="width:120px" value="0"></label>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="place-btn" style="flex:1;justify-content:center">Place</button>
          <button class="default-btn" style="flex:1;justify-content:center">Default</button>
        </div>`
      backdrop.append(dialog)
      document.body.append(backdrop)
      const place = () => {
        const tileX = +(
          dialog.querySelector<HTMLInputElement>('.tilex')!.value
        )
        const tileY = +(
          dialog.querySelector<HTMLInputElement>('.tiley')!.value
        )
        const pixelX = +(
          dialog.querySelector<HTMLInputElement>('.pixelx')!.value
        )
        const pixelY = +(
          dialog.querySelector<HTMLInputElement>('.pixely')!.value
        )
        backdrop.remove()
        resolve({ tileX, tileY, pixelX, pixelY })
      }
      const useDefault = () => {
        backdrop.remove()
        resolve(undefined)
      }
      dialog
        .querySelector<HTMLButtonElement>('.place-btn')!
        .addEventListener('click', place)
      dialog
        .querySelector<HTMLButtonElement>('.default-btn')!
        .addEventListener('click', useDefault)
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) useDefault()
      })
    })
  }

  // protected async pumpkinHunt() {
  //   this.$pumpkinHunt.disabled = false
  //   const PUMPKIN_PATTERN =
  //     '8,8,8,8,8,8,8,1,8,8,8,1,8,8,8,1,8,8,8,8,8,8_8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8_8,1,1,1,1,8,8,8,8,8,8,8,8,8,8,8,8,8,1,1,1,1_8,8,1,1,1,1,1,1,8,8,8,8,8,8,8,1,1,1,1,1,1,8_8,8,1,1,1,5,5,1,1,8,8,8,8,8,1,1,5,5,1,1,1,8_8,8,1,1,1,5,5,1,1,1,8,8,8,1,1,1,5,5,1,1,1,8_8,8,8,1,1,1,1,1,1,8,8,1,8,8,1,1,1,1,1,1,8,8_8,8,8,8,1,1,1,1,8,8,1,1,1,8,8,1,1,1,1,8,8,8_8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8,8_8,8,8,8,1,8,8,8,8,8,8,1,8,8,8,8,8,8,1,8,8,8_8,8,8,1,1,1,8,8,8,8,1,1,1,8,8,8,8,1,1,1,8,8_8,8,1,1,8,1,1,8,8,1,1,8,1,1,8,8,1,1,8,1,1,8_1,8,8,8,8,8,1,1,1,1,8,8,8,1,1,1,1,8,8,8,8,8_1,1,1,8,8,8,8,1,1,8,8,8,8,8,1,1,8,8,8,8,1,1_1,12,12,1,1,8,8,8,8,8,8,1,8,8,8,8,8,8,1,1,19,18_1,12,12,13,13,1,1,1,1,1,1,19,1,1,1,1,1,1,18,18,18,18_12,13,13,13,13,13,13,19,19,19,19,19,19,19,19,19,18,18,18,18,18,18_13,13,13,13,13,13,13,19,19,19,19,19,19,19,19,19,18,18,18,18,18,18_18,18,19,19,13,13,13,13,13,13,13,13,19,19,19,19,18,18,18,18,18,18_18,18,19,19,13,13,13,13,13,13,13,13,19,19,19,19,18,18,18,18,18,18_18,18,19,19,19,19,19,19,19,19,19,19,13,13,13,13,18,18,18,18,18,18_18,18,18,19,19,19,19,19,19,19,19,19,13,13,13,13,18,18,18,18,18,18_18,18,18,18,19,19,19,19,19,19,13,13,13,13,12,12,12,18,18,18,18,18_18,18,18,18,18,18,18,18,18,18,12,12,12,12,12,12,12,18,18,18,18,18_18,18,18,18,18,18,18,18,18,18,12,12,12,12,12,12,12,18,18,18,18,18_1,18,18,18,18,18,18,18,18,18,12,12,12,12,12,12,12,12,12,12,18,18_1,18,18,18,18,18,18,18,18,18,18,12,12,12,12,12,12,12,12,12,18,18_1,18,18,18,18,18,18,18,18,18,18,18,12,12,12,12,12,12,12,12,18,18'
  //       .split('_')
  //       .map((x) => x.split(',').map((x) => +x))
  //   const firstColor = PUMPKIN_PATTERN[0]![0]!
  //   try {
  //     main: while (true) {
  //       const claimed = new Set(
  //         (
  //           await retry(
  //             () =>
  //               fetch(
  //                 'https://backend.wplace.live/event/hallowen/pumpkins/claimed',
  //                 {
  //                   credentials: 'include',
  //                 },
  //               ).then((x) => x.json()) as Promise<{ claimed: number[] }>,
  //             10,
  //             10_000,
  //           )
  //         ).claimed,
  //       )
  //       const pumpkinsFound = Object.entries(
  //         (await retry(
  //           () =>
  //             fetch('https://wplace.samuelscheit.com/tiles/pumpkin.json').then(
  //               (x) => x.json(),
  //             ),
  //           10,
  //           10_000,
  //         )) as Record<
  //           string,
  //           {
  //             foundAt: string
  //             lat: number
  //             lng: number
  //             offsetX: number
  //             offsetY: number
  //             tileX: number
  //             tileY: number
  //           }
  //         >,
  //       )

  //       for (const [index, pumpkin] of pumpkinsFound) {
  //         if (claimed.size === 100) {
  //           this.$pumpkinHunt.textContent = `Pumpkin Hunt Finished!`
  //           break main
  //         }
  //         this.$pumpkinHunt.textContent = `⌛ Pumpkin Hunt [${claimed.size}/100]`
  //         if (
  //           claimed.has(+index) ||
  //           Date.now() - new Date(pumpkin.foundAt).getTime() > 3_600_000
  //         )
  //           continue

  //         const { pixels } = await retry(
  //           () =>
  //             Pixels.fromJSON(this.bot, {
  //               url: `https://backend.wplace.live/files/s0/tiles/${pumpkin.tileX}/${pumpkin.tileY}.png`,
  //               exactColor: true,
  //             }),
  //           10,
  //           10_000,
  //         )
  //         for (let x = 0; x < 1000; x++) {
  //           nextPixel: for (let y = 0; y < 1000; y++) {
  //             if (pixels[y]![x] !== firstColor) continue
  //             for (let offsetY = 0; offsetY < PUMPKIN_PATTERN.length; offsetY++)
  //               for (
  //                 let offsetX = 0;
  //                 offsetX < PUMPKIN_PATTERN[offsetY]!.length;
  //                 offsetX++
  //               )
  //                 if (
  //                   pixels[y + offsetY]![x + offsetX]! !==
  //                   PUMPKIN_PATTERN[offsetY]![offsetX]!
  //                 )
  //                   continue nextPixel

  //             // Pattern found, check if it's real and click it
  //             const info = await retry(
  //               () =>
  //                 fetch(
  //                   `https://backend.wplace.live/s0/pixel/${pumpkin.tileX}/${pumpkin.tileY}?x=${x + 10}&y=${y + 10}`,
  //                 ).then((x) => x.json()) as Promise<{
  //                   paintedBy: { event?: boolean; eventClaimNumber?: number }
  //                 }>,
  //               3,
  //               10_000,
  //             )
  //             if (!info.paintedBy.event) continue
  //             await retry(
  //               async () => {
  //                 const response = await fetch(
  //                   `https://backend.wplace.live/s0/event/pixel/claim`,
  //                   {
  //                     credentials: 'include',
  //                     body: JSON.stringify({
  //                       event: 'halloween',
  //                       tx: pumpkin.tileX,
  //                       ty: pumpkin.tileY,
  //                       px: x + 10,
  //                       py: y + 10,
  //                     }),
  //                     method: 'POST',
  //                   },
  //                 )
  //                 if (!response.ok) throw new Error('CAN NOT CLAIM')
  //               },
  //               3,
  //               10_000,
  //             )
  //             claimed.add(+index)
  //           }
  //         }
  //         await wait(5000)
  //       }
  //       this.$pumpkinHunt.textContent = `⌛ Pumpkin Hunt (wait 10 min)`
  //       await wait(10 * 1000 * 60)
  //     }
  //   } catch (error) {
  //     console.error(error)
  //     this.$pumpkinHunt.disabled = false
  //     this.$pumpkinHunt.textContent = `❌ Pumpkin Hunt!`
  //   }
  // }
}
