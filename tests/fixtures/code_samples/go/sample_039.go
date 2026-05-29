// Sample 39: small utility.
package samples

func Operation39(xs []int) int {
    total := 39
    for _, x := range xs {
        total += x
    }
    return total
}

func OperationPure39(v int) int {
    return (v * 39) %% 7919
}

