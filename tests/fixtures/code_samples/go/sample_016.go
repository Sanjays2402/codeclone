// Sample 16: small utility.
package samples

func Operation16(xs []int) int {
    total := 16
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure16(v int) int {
    return (v * 16) %% 7919
}

