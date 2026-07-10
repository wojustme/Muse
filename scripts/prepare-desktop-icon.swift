import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let input = root.appendingPathComponent("apps/desktop/src-tauri/icons/source/muse_icon.jpeg")
let output = root.appendingPathComponent("apps/desktop/src-tauri/icons/source/muse_icon.png")

guard let image = NSImage(contentsOf: input),
  let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
  fatalError("Could not read icon source at \(input.path)")
}

let sourceWidth = cgImage.width
let sourceHeight = cgImage.height
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(
  rawValue: CGImageAlphaInfo.premultipliedLast.rawValue
    | CGBitmapInfo.byteOrder32Big.rawValue
)
var sourcePixels = [UInt8](repeating: 0, count: sourceWidth * sourceHeight * 4)

guard
  let sourceContext = CGContext(
    data: &sourcePixels,
    width: sourceWidth,
    height: sourceHeight,
    bitsPerComponent: 8,
    bytesPerRow: sourceWidth * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo.rawValue
  )
else {
  fatalError("Could not create source bitmap context")
}

sourceContext.interpolationQuality = .high
sourceContext.draw(
  cgImage,
  in: CGRect(x: 0, y: 0, width: sourceWidth, height: sourceHeight)
)

func isBackgroundCandidate(_ pixelIndex: Int) -> Bool {
  let red = Int(sourcePixels[pixelIndex])
  let green = Int(sourcePixels[pixelIndex + 1])
  let blue = Int(sourcePixels[pixelIndex + 2])
  let maxChannel = max(red, green, blue)
  let minChannel = min(red, green, blue)
  let saturation = maxChannel - minChannel

  return minChannel > 185 && saturation < 36
}

var connectedBackground = [Bool](repeating: false, count: sourceWidth * sourceHeight)
var queue: [(x: Int, y: Int)] = []
queue.reserveCapacity(sourceWidth * 4)

func enqueueBackground(_ x: Int, _ y: Int) {
  guard x >= 0, y >= 0, x < sourceWidth, y < sourceHeight else {
    return
  }

  let pointIndex = y * sourceWidth + x
  let pixelIndex = pointIndex * 4

  if !connectedBackground[pointIndex] && isBackgroundCandidate(pixelIndex) {
    connectedBackground[pointIndex] = true
    queue.append((x, y))
  }
}

for x in 0..<sourceWidth {
  enqueueBackground(x, 0)
  enqueueBackground(x, sourceHeight - 1)
}

for y in 0..<sourceHeight {
  enqueueBackground(0, y)
  enqueueBackground(sourceWidth - 1, y)
}

var cursor = 0
while cursor < queue.count {
  let point = queue[cursor]
  cursor += 1

  enqueueBackground(point.x + 1, point.y)
  enqueueBackground(point.x - 1, point.y)
  enqueueBackground(point.x, point.y + 1)
  enqueueBackground(point.x, point.y - 1)
}

for pointIndex in connectedBackground.indices where connectedBackground[pointIndex] {
  let index = pointIndex * 4
  let red = Int(sourcePixels[index])
  let green = Int(sourcePixels[index + 1])
  let blue = Int(sourcePixels[index + 2])
  let maxChannel = max(red, green, blue)

  let alphaFactor = min(1, max(0, Double(220 - maxChannel) / 24))
  let nextAlpha = UInt8((Double(sourcePixels[index + 3]) * alphaFactor).rounded())

  sourcePixels[index] = UInt8((Double(red) * alphaFactor).rounded())
  sourcePixels[index + 1] = UInt8((Double(green) * alphaFactor).rounded())
  sourcePixels[index + 2] = UInt8((Double(blue) * alphaFactor).rounded())
  sourcePixels[index + 3] = nextAlpha < 6 ? 0 : nextAlpha
}

let sourceData = Data(sourcePixels)
guard
  let sourceProvider = CGDataProvider(data: sourceData as CFData),
  let transparentIcon = CGImage(
    width: sourceWidth,
    height: sourceHeight,
    bitsPerComponent: 8,
    bitsPerPixel: 32,
    bytesPerRow: sourceWidth * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo,
    provider: sourceProvider,
    decode: nil,
    shouldInterpolate: true,
    intent: .defaultIntent
  )
else {
  fatalError("Could not create transparent icon image")
}

let canvasSize = 1024
let iconScale = 1.045
let drawSize = Double(canvasSize) * iconScale
let inset = (Double(canvasSize) - drawSize) / 2
var canvasPixels = [UInt8](repeating: 0, count: canvasSize * canvasSize * 4)

guard
  let canvasContext = CGContext(
    data: &canvasPixels,
    width: canvasSize,
    height: canvasSize,
    bitsPerComponent: 8,
    bytesPerRow: canvasSize * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo.rawValue
  )
else {
  fatalError("Could not create canvas bitmap context")
}

canvasContext.clear(CGRect(x: 0, y: 0, width: canvasSize, height: canvasSize))
canvasContext.interpolationQuality = .high
canvasContext.draw(
  transparentIcon,
  in: CGRect(x: inset, y: inset, width: drawSize, height: drawSize)
)

let center = Double(canvasSize) / 2
let halfSize = drawSize / 2
let cornerRadius = drawSize * 0.40
let feather = 3.0

for y in 0..<canvasSize {
  for x in 0..<canvasSize {
    let pixelX = Double(x) + 0.5
    let pixelY = Double(y) + 0.5
    let qx = abs(pixelX - center) - (halfSize - cornerRadius)
    let qy = abs(pixelY - center) - (halfSize - cornerRadius)
    let outsideX = max(qx, 0)
    let outsideY = max(qy, 0)
    let outsideDistance =
      sqrt((outsideX * outsideX) + (outsideY * outsideY))
      + min(max(qx, qy), 0) - cornerRadius

    if outsideDistance > 0 {
      let pointIndex = (y * canvasSize + x) * 4
      let alphaFactor = min(1, max(0, (feather - outsideDistance) / feather))

      canvasPixels[pointIndex] = UInt8((Double(canvasPixels[pointIndex]) * alphaFactor).rounded())
      canvasPixels[pointIndex + 1] = UInt8((Double(canvasPixels[pointIndex + 1]) * alphaFactor).rounded())
      canvasPixels[pointIndex + 2] = UInt8((Double(canvasPixels[pointIndex + 2]) * alphaFactor).rounded())
      canvasPixels[pointIndex + 3] = UInt8((Double(canvasPixels[pointIndex + 3]) * alphaFactor).rounded())
    }
  }
}

let canvasData = Data(canvasPixels)
guard
  let canvasProvider = CGDataProvider(data: canvasData as CFData),
  let finalImage = CGImage(
    width: canvasSize,
    height: canvasSize,
    bitsPerComponent: 8,
    bitsPerPixel: 32,
    bytesPerRow: canvasSize * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo,
    provider: canvasProvider,
    decode: nil,
    shouldInterpolate: true,
    intent: .defaultIntent
  )
else {
  fatalError("Could not create final icon image")
}

let representation = NSBitmapImageRep(cgImage: finalImage)
guard let pngData = representation.representation(using: .png, properties: [:]) else {
  fatalError("Could not encode icon PNG")
}

try pngData.write(to: output, options: [.atomic])
print("Wrote optimized desktop icon to \(output.path)")
