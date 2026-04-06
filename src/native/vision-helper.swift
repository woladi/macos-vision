import Vision
import AppKit
import Foundation

// Struktura do mapowania wyników na JSON
struct OCRResult: Codable {
    let t: String // tekst
    let x: Double // x (0-1)
    let y: Double // y (0-1)
    let w: Double // szerokość
    let h: Double // wysokość
}

let args = CommandLine.arguments

// Prosty parser argumentów
let isJsonMode = args.contains("--json")
let fileArgs = args.filter { !$0.hasPrefix("--") && !$0.contains("vision-helper") }

guard let imagePath = fileArgs.first else {
    print("Użycie: vision-helper [--json] <sciezka_do_pliku>")
    exit(0)
}

let imageURL = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageURL),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("BŁĄD: Nie można otworzyć pliku: \(imagePath)")
    exit(1)
}

var results: [OCRResult] = []
var rawText = ""

let request = VNRecognizeTextRequest { (request, error) in
    guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
    
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        
        if isJsonMode {
            // Vision używa układu współrzędnych, gdzie 0,0 jest w LEWYM DOLNYM rogu.
            // Odwracamy Y, aby 0,0 było w LEWYM GÓRNYM (standard w web/dev).
            let box = observation.boundingBox
            let result = OCRResult(
                t: candidate.string,
                x: Double(box.origin.x),
                y: Double(1.0 - box.origin.y - box.size.height),
                w: Double(box.size.width),
                h: Double(box.size.height)
            )
            results.append(result)
        } else {
            rawText += candidate.string + "\n"
        }
    }
}

request.recognitionLevel = .accurate
request.recognitionLanguages = ["pl-PL", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
    
    if isJsonMode {
        let encoder = JSONEncoder()
        // encoder.outputFormatting = .prettyPrinted // Odkomentuj, jeśli chcesz ładny format w terminalu
        if let jsonData = try? encoder.encode(results),
           let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
        }
    } else {
        print(rawText.trimmingCharacters(in: .whitespacesAndNewlines))
    }
} catch {
    print("BŁĄD: \(error)")
    exit(1)
}