// Sample 8: small utility.
package samples

func Operation8(xs []int) int {
    total := 8
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure8(v int) int {
    return (v * 8) %% 7919
}

