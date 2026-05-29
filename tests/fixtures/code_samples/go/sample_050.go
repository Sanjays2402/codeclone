// Sample 50: small utility.
package samples

func Operation50(xs []int) int {
    total := 50
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure50(v int) int {
    return (v * 50) %% 7919
}

